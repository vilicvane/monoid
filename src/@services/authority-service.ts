import {App} from '@capacitor/app';
import {Browser} from '@capacitor/browser';
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
  browserOpen: boolean;
  browserFinished: boolean;
  opening?: Promise<void>;
  finishing?: Promise<void>;
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
    if (this.login) {
      if (!this.login.browserFinished || this.login.claimed)
        return this.login.promise;
      this.login.claimed = true;
      this.login.controller.abort();
      clearTimeout(this.loginTimer);
      this.login.reject(new AuthorityError('cancelled'));
    }
    const login = this.begin({
      authorityUrl: this.authorityUrl,
      state: authorityRandomToken(),
      codeVerifier: authorityRandomToken(),
      expiresAt: Date.now() + AUTHORITY_LOGIN_TTL,
    });
    void this.savePending().then(
      () => this.open(login),
      () => this.finish(login, new AuthorityError('service_error')),
    );
    return login.promise;
  }

  async cancelSignIn(): Promise<void> {
    if (this.login)
      await this.finish(this.login, new AuthorityError('cancelled'));
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

  async handleCallback(url: string): Promise<void> {
    const login = this.login;
    if (!login || login.claimed || login.finishing)
      throw new AuthorityError('invalid_callback');
    let code: string;
    try {
      code = authorityCallback(url, login.pending.state);
      if (Date.now() >= login.pending.expiresAt)
        throw new AuthorityError('expired');
    } catch (error) {
      if (error instanceof AuthorityError && error.code !== 'invalid_callback')
        await this.finish(login, error);
      throw error;
    }
    // Claim before any await so warm/cold delivery cannot redeem the same code twice.
    login.claimed = true;
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
      await this.finish(login, undefined, session);
    } catch (error) {
      await this.finish(login, this.error(error));
    }
  }

  private begin(pending: AuthorityPendingLogin): Login {
    let resolve!: Login['resolve'];
    let reject!: Login['reject'];
    const promise = new Promise<AuthorityAccount>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    // Cold callbacks can settle before a view subscribes; keep the rejection available to await.
    void promise.catch(() => {});
    const login: Login = {
      pending,
      promise,
      resolve,
      reject,
      controller: new AbortController(),
      claimed: false,
      browserOpen: false,
      browserFinished: false,
    };
    this.login = login;
    runInAction(() => this.loginState.set({status: 'pending'}));
    this.loginTimer = setTimeout(
      () => {
        void this.finish(login, new AuthorityError('expired'));
      },
      Math.max(0, pending.expiresAt - Date.now()),
    );
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
      login.browserOpen = true;
      login.opening = Browser.open({url: url.href});
      await login.opening;
    } catch (error) {
      await this.finish(login, this.error(error));
    }
  }

  private finish(
    login: Login,
    error?: AuthorityError,
    session?: Session,
  ): Promise<void> {
    if (login.finishing || this.login !== login) {
      if (session) this.logout(session);
      return login.finishing ?? Promise.resolve();
    }
    if (session) this.clearSession();
    const owner = this.session.signal;
    login.claimed = true;
    login.controller.abort();
    clearTimeout(this.loginTimer);
    login.finishing = (async () => {
      try {
        await this.savePending();
      } catch {
        error = new AuthorityError('service_error');
      }
      // Closing a dismissed browser must not turn into another exchange.
      try {
        await login.opening?.catch(() => {});
        await Browser.close();
      } catch {
        /* The session still settles. */
      }
      this.login = undefined;
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
      runInAction(() => this.loginState.set({status: 'error', error: failure}));
      login.reject(failure);
    })();
    return login.finishing;
  }

  private savePending(pending?: AuthorityPendingLogin): Promise<void> {
    this.writing = this.writing
      .catch(() => {})
      .then(() =>
        pending
          ? this.storage.set('authorityLogin', pending)
          : this.storage.remove('authorityLogin'),
      );
    return this.writing;
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
    if (saved) {
      if (
        AuthorityPendingLogin.is(saved) &&
        saved.authorityUrl === service.authorityUrl &&
        /^[A-Za-z0-9_-]{43}$/.test(saved.state) &&
        /^[A-Za-z0-9_-]{43}$/.test(saved.codeVerifier) &&
        saved.expiresAt > Date.now() &&
        saved.expiresAt <= Date.now() + AUTHORITY_LOGIN_TTL
      )
        service.begin(saved).browserOpen = true;
      else await storage.remove('authorityLogin');
    }
    await App.addListener('appUrlOpen', ({url}) => {
      void service.handleCallback(url).catch(() => {
        /* Unrelated links cannot consume the pending flow. */
      });
    });
    await Browser.addListener('browserFinished', () => {
      const login = service.login;
      if (login?.browserOpen && !login.claimed) {
        login.browserFinished = true;
        login.browserOpen = false;
        runInAction(() => service.loginState.set({status: 'idle'}));
      }
    });
    const launch = await App.getLaunchUrl();
    if (launch) void service.handleCallback(launch.url).catch(() => {});
    return service;
  }
}
