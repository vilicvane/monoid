import {App} from '@capacitor/app';
import {AppLauncher} from '@capacitor/app-launcher';
import {base64urlnopad} from '@scure/base';
import {observable, runInAction} from 'mobx';
import * as x from 'x-value';

import {
  AUTHORITY_CALLBACK_URI,
  AUTHORITY_LOGIN_TTL,
  AuthorityAccount,
  AuthorityBundle,
  AuthorityError,
  AuthorityGroup,
  AuthorityMetadata,
  AuthorityNamespace,
  type AuthorityOwner,
  AuthorityPendingLogin,
  authorityBytes,
  authorityCallback,
  authorityPKCEChallenge,
  authorityRandomToken,
} from '../@lib/authority-client.js';
import {authorityApiUrl, normalizeAuthorityUrl} from '../@lib/authority-url.js';
import {HeldPINValue} from '../@lib/held-pins.js';

import type {StorageService} from './storage-service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    authorityLogin: AuthorityPendingLogin;
  }
}

type Session = {
  accessToken: string;
  account: AuthorityAccount;
};
type Login = {
  pending: AuthorityPendingLogin;
  promise: Promise<AuthorityAccount>;
  resolve: (account: AuthorityAccount) => void;
  reject: (error: AuthorityError) => void;
  controller: AbortController;
  claimed: boolean;
};
export type AuthoritySignInState =
  | {status: 'idle' | 'pending' | 'complete'}
  | {status: 'error'; error: AuthorityError};

export class AuthorityService {
  private readonly session = new HeldPINValue<Session>(session => {
    if (session) this.logout(session);
    runInAction(() => this.accountState.set(undefined));
  });
  private readonly accountState = observable.box<AuthorityAccount | undefined>(
    undefined,
    {deep: false},
  );
  private readonly loginState = observable.box<AuthoritySignInState>(
    {status: 'idle'},
    {deep: false},
  );
  private login: Login | undefined;
  private loginTimer: ReturnType<typeof setTimeout> | undefined;
  private writing = Promise.resolve();

  private constructor(
    private readonly storage: StorageService,
    readonly authorityUrl: string,
  ) {}

  get account(): AuthorityAccount | undefined {
    this.session.peek();
    return this.accountState.get();
  }

  get signedIn(): boolean {
    return !!this.account;
  }

  get signInState(): AuthoritySignInState {
    return this.loginState.get();
  }

  get pendingSignIn(): Promise<AuthorityAccount> | undefined {
    return this.login?.promise;
  }

  async metadata(): Promise<AuthorityMetadata> {
    const metadata = await this.request('v1/metadata', AuthorityMetadata);
    return {...metadata, publicKey: authorityBytes(metadata.publicKey, 65)};
  }

  signIn(): Promise<AuthorityAccount> {
    if (this.login) this.finish(this.login, new AuthorityError('cancelled'));
    const login = this.begin({
      authorityUrl: this.authorityUrl,
      state: authorityRandomToken(),
      codeVerifier: authorityRandomToken(),
      expiresAt: Date.now() + AUTHORITY_LOGIN_TTL,
    });
    runInAction(() => this.loginState.set({status: 'pending'}));
    void this.open(login);
    return login.promise;
  }

  async cancelSignIn(): Promise<void> {
    if (this.login) this.finish(this.login, new AuthorityError('cancelled'));
    await this.writing;
  }

  async signOut(): Promise<void> {
    this.clearSession();
    await this.cancelSignIn();
  }

  async namespaces(): Promise<AuthorityNamespace[]> {
    const result = await this.request(
      'v1/namespaces',
      x.object({namespaces: x.array(AuthorityNamespace)}),
      undefined,
      this.requireSession(),
    );
    return result.namespaces;
  }

  async groups(owner: AuthorityOwner): Promise<AuthorityGroup[]> {
    const groups: AuthorityGroup[] = [];
    let after: string | undefined;
    const seen = new Set<string>();
    for (;;) {
      const page = await this.request(
        'v1/groups/list',
        x.object({
          groups: x.array(AuthorityGroup),
          next: x.union([x.string, x.null]),
        }),
        {owner, ...(after !== undefined && {after})},
        this.requireSession(),
      );
      groups.push(...page.groups);
      if (page.next === null) return groups;
      if (seen.has(page.next)) throw new AuthorityError('service_error');
      seen.add(page.next);
      after = page.next;
    }
  }

  async issueBundle(input: {
    owner: AuthorityOwner;
    groupName: string;
    allowPeerExtension: boolean;
    recipientPublicKey: Uint8Array;
  }): Promise<AuthorityBundle> {
    const bundle = await this.request(
      'v1/bundle',
      AuthorityBundle,
      {
        ...input,
        recipientPublicKey: base64urlnopad.encode(input.recipientPublicKey),
      },
      this.requireSession(),
    );
    return {
      ...bundle,
      publicKey: authorityBytes(bundle.publicKey, 65),
      data: authorityBytes(bundle.data, 182),
      bundle: authorityBytes(bundle.bundle, 32),
    };
  }

  private async handleCallback(url: string): Promise<void> {
    const login = this.login;
    if (!login || login.claimed) return;
    let code: string;
    try {
      code = authorityCallback(url, login.pending.state);
    } catch (error) {
      if (error instanceof AuthorityError && error.code === 'cancelled')
        this.finish(login, error);
      return;
    }
    if (Date.now() >= login.pending.expiresAt) {
      this.finish(login, new AuthorityError('expired'));
      return;
    }
    // Launch URLs and appUrlOpen can deliver the same link before either awaits.
    login.claimed = true;
    runInAction(() => this.loginState.set({status: 'pending'}));
    try {
      await this.savePending();
      login.controller.signal.throwIfAborted();
      const token = await this.request(
        'auth/login/token',
        x.object({
          accessToken: x.string,
          tokenType: x.literal('Bearer'),
          expiresIn: x.number,
          account: AuthorityAccount,
        }),
        {
          code,
          codeVerifier: login.pending.codeVerifier,
          redirectUri: AUTHORITY_CALLBACK_URI,
        },
        undefined,
        login.controller.signal,
      );
      if (!token.accessToken || token.expiresIn <= 0 || token.expiresIn > 900)
        throw new AuthorityError('service_error');
      const session = {
        accessToken: token.accessToken,
        account: token.account,
      };
      this.finish(login, undefined, session);
    } catch (error) {
      this.finish(login, this.error(error));
    }
  }

  private begin(pending: AuthorityPendingLogin): Login {
    let resolve!: Login['resolve'];
    let reject!: Login['reject'];
    const promise = new Promise<AuthorityAccount>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    // A view may observe signInState instead of awaiting the promise.
    void promise.catch(() => {});
    const login: Login = {
      pending,
      promise,
      resolve,
      reject,
      controller: new AbortController(),
      claimed: false,
    };
    this.login = login;
    this.loginTimer = setTimeout(() => {
      this.finish(login, new AuthorityError('expired'));
    }, pending.expiresAt - Date.now());
    return login;
  }

  private async open(login: Login): Promise<void> {
    try {
      const result = await this.request(
        'auth/login/start',
        x.object({authorizationUrl: x.string, expiresIn: x.number}),
        {
          redirectUri: AUTHORITY_CALLBACK_URI,
          state: login.pending.state,
          codeChallenge: authorityPKCEChallenge(login.pending.codeVerifier),
          codeChallengeMethod: 'S256',
        },
        undefined,
        login.controller.signal,
      );
      const url = new URL(result.authorizationUrl);
      const expected = new URL(
        authorityApiUrl(this.authorityUrl, 'auth/login'),
      );
      if (
        url.origin !== expected.origin ||
        url.pathname !== expected.pathname ||
        url.username ||
        url.password ||
        url.hash ||
        result.expiresIn <= 0 ||
        result.expiresIn > 600
      )
        throw new AuthorityError('service_error');
      login.controller.signal.throwIfAborted();
      await this.savePending(login.pending);
      login.controller.signal.throwIfAborted();
      const {completed} = await AppLauncher.openUrl({url: url.href});
      if (!completed) throw new AuthorityError('service_error');
      if (this.login === login && !login.claimed)
        runInAction(() => this.loginState.set({status: 'idle'}));
    } catch (error) {
      if (!login.claimed) this.finish(login, this.error(error));
    }
  }

  private finish(
    login: Login,
    error?: AuthorityError,
    session?: Session,
  ): void {
    if (this.login !== login) {
      if (session) this.logout(session);
      return;
    }
    this.login = undefined;
    void this.savePending().catch(() => {});
    if (session) this.clearSession();
    const owner = this.session.signal;
    login.controller.abort();
    clearTimeout(this.loginTimer);
    if (!error && session) {
      this.session.set(session, owner);
      if (this.session.peek() === session) {
        runInAction(() => {
          this.accountState.set(session.account);
          this.loginState.set({status: 'complete'});
        });
        login.resolve(session.account);
        return;
      }
      error = new AuthorityError('cancelled');
    }
    if (session) this.logout(session);
    const failure = error ?? new AuthorityError('service_error');
    runInAction(() =>
      this.loginState.set(
        failure.code === 'cancelled' || failure.code === 'expired'
          ? {status: 'idle'}
          : {status: 'error', error: failure},
      ),
    );
    login.reject(failure);
  }

  private savePending(pending?: AuthorityPendingLogin): Promise<void> {
    const writing = this.writing.then(() =>
      pending
        ? this.storage.set('authorityLogin', pending)
        : this.storage.remove('authorityLogin'),
    );
    this.writing = writing.catch(() => {});
    return writing;
  }

  private requireSession(): Session {
    const session = this.session.peek();
    if (!session) throw new AuthorityError('unauthorized');
    return session;
  }

  private clearSession(expected?: Session): void {
    if (!expected || this.session.peek() === expected) this.session.clear();
  }

  private logout(session: Session): void {
    void this.request('auth/logout', undefined, {}, session).catch(() => {});
  }

  private error(error: unknown): AuthorityError {
    return error instanceof AuthorityError
      ? error
      : new AuthorityError('service_error');
  }

  private async request<T>(
    path: string,
    schema?: {sanitize(value: unknown): T},
    body?: object,
    session?: Session,
    signal?: AbortSignal,
  ): Promise<T> {
    // Only authenticated requests renew the Worker's idle window.
    if (session && path !== 'auth/logout') this.session.get();
    let response: Response;
    try {
      response = await fetch(authorityApiUrl(this.authorityUrl, path), {
        method: body ? 'POST' : 'GET',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        headers: {
          ...(body && {'Content-Type': 'application/json'}),
          ...(session && {Authorization: `Bearer ${session.accessToken}`}),
        },
        body: body && JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AuthorityError('network_error');
    }
    if (response.status === 401 && session && path !== 'auth/logout')
      this.clearSession(session);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 || data?.error === 'unauthorized') {
        if (session && response.status !== 401 && path !== 'auth/logout')
          this.clearSession(session);
        throw new AuthorityError('unauthorized');
      }
      if (path === 'auth/login/token' && data?.error === 'invalid_grant')
        throw new AuthorityError('expired');
      if (response.status === 409 && data?.error === 'bundle_policy_conflict')
        throw new AuthorityError('bundle_policy_conflict');
      if (response.status === 429) throw new AuthorityError('rate_limited');
      throw new AuthorityError('service_error');
    }
    try {
      return schema ? schema.sanitize(await response.json()) : (undefined as T);
    } catch {
      throw new AuthorityError('service_error');
    }
  }

  static async create(
    storage: StorageService,
    baseUrl = import.meta.env?.VITE_AUTHORITY_URL ||
      'https://authority.monoid.app/',
  ): Promise<AuthorityService> {
    const service = new AuthorityService(
      storage,
      normalizeAuthorityUrl(baseUrl),
    );
    const saved = await storage.get('authorityLogin');
    if (saved !== undefined) {
      if (
        AuthorityPendingLogin.is(saved) &&
        saved.authorityUrl === service.authorityUrl &&
        /^[A-Za-z0-9_-]{43}$/.test(saved.state) &&
        /^[A-Za-z0-9_-]{43}$/.test(saved.codeVerifier) &&
        saved.expiresAt > Date.now() &&
        saved.expiresAt <= Date.now() + AUTHORITY_LOGIN_TTL
      )
        service.begin(saved);
      else await storage.remove('authorityLogin');
    }
    await App.addListener('appUrlOpen', ({url}) => {
      void service.handleCallback(url);
    });
    const launch = await App.getLaunchUrl();
    if (launch?.url) void service.handleCallback(launch.url);
    return service;
  }
}
