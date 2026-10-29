import {
  type SSHKeyMetadata,
  type SSHKeyMetadataResult,
  SSHProtocolError,
  type SSHSignParams,
  SSH_CHAIN_ID,
  SSH_ERROR_CODES,
  SSH_METADATA_EVENT,
  SSH_METADATA_METHOD,
  decodeBase64,
  parseSSHKeyMetadataResult,
  requestDigest,
  verifySSHSignature,
} from '@monoid/ssh-protocol';
import type {IWalletKit, WalletKitTypes} from '@reown/walletkit';
import {comparer, observable, reaction, runInAction} from 'mobx';

import {
  assertSSHMetadataRequest,
  getSSHSessionAccounts,
  parseSSHRequest,
} from '../@lib/ssh-request.js';

import {type SSHKeyCandidates, getSSHKeyMetadata} from './ssh-key-store.js';
import type {StorageService} from './storage-service.js';
import {WalletConnectSigningLock} from './wallet-connect-signing-lock.js';
import type {WalletKitSession} from './wallet-kit-service.js';

type Authorization = {
  desired: string[];
  approved: string[];
  generations: Record<string, number>;
  syncPending: boolean;
  revision: number;
};

type LedgerEntry = {
  topic: string;
  id: number;
  digest: string;
  expiresAt: number;
  wcExpiry: number;
  state: 'pending' | 'terminal';
};

type SSHWalletState = {
  authorizations: Record<string, Authorization>;
  ledger: Record<string, LedgerEntry>;
};

export type SSHWalletRequest = {
  request: WalletKitTypes.SessionRequest;
  params: SSHSignParams;
  digest: string;
  generation: number;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    sshWalletState: SSHWalletState;
  }
}

const keyOf = ({topic, id}: {topic: string; id: number}): string =>
  JSON.stringify([topic, id]);

export class SSHWalletService {
  readonly signingLock = new WalletConnectSigningLock();
  readonly pending = observable.map<string, SSHWalletRequest>([], {
    deep: false,
  });
  readonly syncing = observable.set<string>();
  private state: SSHWalletState;
  private writing = Promise.resolve();
  private receiving = Promise.resolve();
  private claimed: string | undefined;
  private signing = false;
  private releaseSigning: (() => void) | undefined;
  private storageFailed = false;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private completing = new Map<string, Promise<void>>();
  private registering = new Set<string>();
  private metadataRequests = new Map<string, Promise<void>>();
  private metadataSending = new Set<string>();
  private metadataDirty = new Set<string>();

  constructor(
    private kit: IWalletKit,
    private storage: StorageService,
    stored?: SSHWalletState,
    private candidates: SSHKeyCandidates = () => [],
  ) {
    this.state = stored ?? {authorizations: {}, ledger: {}};
    // Restored pending entries are intentionally not made interactive again.
    for (const [topic, value] of Object.entries(this.state.authorizations)) {
      if (value.syncPending) this.syncing.add(topic);
    }
    reaction(
      () => this.candidates().map(getSSHKeyMetadata),
      (current, previous) => {
        for (const topic of Object.keys(this.kit.getActiveSessions())) {
          try {
            const accounts = this.metadataAccounts(topic);
            const selected = (
              keys: readonly SSHKeyMetadata[],
            ): SSHKeyMetadata[] =>
              keys.filter(key => accounts.includes(key.account));
            if (!comparer.structural(selected(current), selected(previous)))
              this.notifyMetadataChanged(topic);
          } catch {
            // An unavailable authorization must not disclose any Safe changes.
          }
        }
      },
      {equals: comparer.structural},
    );
  }

  async registerSession(session: WalletKitSession): Promise<void> {
    const accounts = getSSHSessionAccounts(session);
    if (!accounts.length) return;
    if (this.state.authorizations[session.topic])
      throw new Error('SSH session authorization already exists.');
    this.state.authorizations[session.topic] = {
      desired: accounts,
      approved: accounts,
      generations: {},
      syncPending: false,
      revision: 0,
    };
    this.registering.add(session.topic);
    try {
      await this.persist();
    } finally {
      this.registering.delete(session.topic);
    }
    this.notifyMetadataChanged(session.topic);
  }

  getDesiredAccounts(topic: string): readonly string[] | undefined {
    return this.state.authorizations[topic]?.desired;
  }

  async beginSwitch(
    topic: string,
    accounts: readonly string[],
  ): Promise<number> {
    const authorization = this.state.authorizations[topic];
    if (!authorization)
      throw new SSHProtocolError(SSH_ERROR_CODES.unauthorized);
    for (const account of authorization.desired) {
      if (!accounts.includes(account))
        authorization.generations[account] =
          (authorization.generations[account] ?? 0) + 1;
    }
    authorization.desired = [...accounts];
    authorization.approved = authorization.approved.filter(account =>
      accounts.includes(account),
    );
    authorization.syncPending = true;
    authorization.revision++;
    runInAction(() => this.syncing.add(topic));
    const revision = authorization.revision;
    this.cancelInvalid(topic);
    await this.persist();
    return revision;
  }

  async acknowledgeSwitch(topic: string, revision: number): Promise<void> {
    const authorization = this.state.authorizations[topic];
    if (!authorization || authorization.revision !== revision)
      throw new SSHProtocolError(SSH_ERROR_CODES.cancelled);
    const session = this.kit.getActiveSessions()[topic];
    const actual = session && getSSHSessionAccounts(session);
    if (
      !actual ||
      actual.length !== authorization.desired.length ||
      actual.some(account => !authorization.desired.includes(account))
    ) {
      throw new Error('SSH account update is not synchronized.');
    }
    authorization.approved = [...authorization.desired];
    authorization.syncPending = false;
    await this.persist();
    runInAction(() => this.syncing.delete(topic));
    this.notifyMetadataChanged(topic);
  }

  /** Best-effort invalidation only; names and contexts are read on demand. */
  notifyMetadataChanged(topic?: string): void {
    for (const current of topic
      ? [topic]
      : Object.keys(this.kit.getActiveSessions())) {
      try {
        this.metadataAccounts(current);
      } catch {
        continue;
      }
      this.metadataDirty.add(current);
      if (this.metadataSending.has(current)) continue;
      this.metadataSending.add(current);
      void (async () => {
        try {
          while (this.metadataDirty.delete(current)) {
            this.metadataAccounts(current);
            const session = this.kit.getActiveSessions()[current];
            if (
              !Object.entries(session.namespaces).some(
                ([name, namespace]) =>
                  (name === 'monoid' || name === SSH_CHAIN_ID) &&
                  (!namespace.chains ||
                    namespace.chains.includes(SSH_CHAIN_ID)) &&
                  namespace.methods.includes(SSH_METADATA_METHOD) &&
                  namespace.events.includes(SSH_METADATA_EVENT),
              )
            )
              break;
            await this.kit.emitSessionEvent({
              topic: current,
              chainId: SSH_CHAIN_ID,
              event: {name: SSH_METADATA_EVENT, data: {}},
            });
          }
        } catch {
          // A later change or relay reconnection retries invalidation.
        } finally {
          this.metadataDirty.delete(current);
          this.metadataSending.delete(current);
        }
      })();
    }
  }

  private metadataAccounts(topic: string): readonly string[] {
    if (this.storageFailed)
      throw new SSHProtocolError(SSH_ERROR_CODES.internalError);
    const session = this.kit.getActiveSessions()[topic];
    if (
      !session ||
      !Number.isFinite(session.expiry) ||
      session.expiry * 1000 <= Date.now()
    )
      throw new SSHProtocolError(SSH_ERROR_CODES.expired);
    const authorization = this.state.authorizations[topic];
    if (
      !authorization ||
      authorization.syncPending ||
      this.syncing.has(topic) ||
      this.registering.has(topic)
    )
      throw new SSHProtocolError(SSH_ERROR_CODES.unauthorized);
    const actual = getSSHSessionAccounts(session, SSH_METADATA_METHOD);
    const accounts = authorization.approved.filter(
      account =>
        authorization.desired.includes(account) && actual.includes(account),
    );
    if (!accounts.length)
      throw new SSHProtocolError(SSH_ERROR_CODES.unauthorized);
    return accounts;
  }

  private getMetadata(topic: string): SSHKeyMetadataResult {
    const accounts = this.metadataAccounts(topic);
    return parseSSHKeyMetadataResult({
      keys: this.candidates()
        .filter(key => accounts.includes(key.account))
        .map(getSSHKeyMetadata),
    });
  }

  private receiveMetadata(
    request: WalletKitTypes.SessionRequest,
  ): Promise<void> {
    const key = keyOf(request);
    const pending = this.metadataRequests.get(key);
    if (pending) return pending;
    const snapshot = structuredClone(request);
    const operation = Promise.resolve()
      .then(async () => {
        let result: SSHKeyMetadataResult;
        try {
          assertSSHMetadataRequest(snapshot);
          result = this.getMetadata(snapshot.topic);
        } catch (error) {
          await this.sendError(snapshot, this.protocolError(error));
          return;
        }
        // No await between reading current authority and submitting the response.
        await this.kit.respondSessionRequest({
          topic: snapshot.topic,
          response: {id: snapshot.id, jsonrpc: '2.0', result},
        });
      })
      .finally(() => this.metadataRequests.delete(key));
    this.metadataRequests.set(key, operation);
    return operation;
  }

  invalidateSession(topic: string): void {
    const authorization = this.state.authorizations[topic];
    if (authorization) {
      for (const account of authorization.desired)
        authorization.generations[account] =
          (authorization.generations[account] ?? 0) + 1;
      authorization.desired = [];
      authorization.approved = [];
      authorization.syncPending = true;
      authorization.revision++;
    }
    this.cancelInvalid(topic);
    void this.persist().catch(() => {});
  }

  refresh(): void {
    for (const value of this.pending.values()) {
      try {
        this.assertPending(value);
      } catch (error) {
        void this.finish(value, undefined, this.protocolError(error)).catch(
          () => {},
        );
      }
    }
  }

  receive(
    request: WalletKitTypes.SessionRequest,
    externallyBusy = false,
  ): Promise<void> {
    if (request.params.request.method === SSH_METADATA_METHOD)
      return this.receiveMetadata(request);
    const result = this.receiving.then(() =>
      this.accept(request, externallyBusy),
    );
    this.receiving = result.catch(() => {});
    return result;
  }

  private async accept(
    request: WalletKitTypes.SessionRequest,
    externallyBusy: boolean,
  ): Promise<void> {
    let params: SSHSignParams;
    try {
      params = parseSSHRequest(request);
    } catch (error) {
      await this.sendError(request, this.protocolError(error));
      return;
    }
    const key = keyOf(request);
    const digest = requestDigest(params);
    const existing = this.state.ledger[key];
    if (existing) {
      if (existing.digest !== digest) {
        const active = this.pending.get(key);
        if (active)
          await this.finish(
            active,
            undefined,
            new SSHProtocolError(SSH_ERROR_CODES.invalidParams),
          );
        else
          await this.sendError(
            request,
            new SSHProtocolError(SSH_ERROR_CODES.invalidParams),
          );
      } else if (!this.pending.has(key)) {
        if (existing.state === 'pending') {
          existing.state = 'terminal';
          await this.persist();
        }
        await this.sendError(
          request,
          new SSHProtocolError(SSH_ERROR_CODES.cancelled),
        );
      }
      return;
    }
    const authorization = this.state.authorizations[request.topic];
    const value: SSHWalletRequest = {
      request: structuredClone(request),
      params,
      digest,
      generation: authorization?.generations[params.account] ?? 0,
    };
    let error: SSHProtocolError | undefined;
    try {
      this.assertAuthorization(value);
      if (this.claimed || this.signing || externallyBusy)
        throw new SSHProtocolError(SSH_ERROR_CODES.busy);
      this.releaseSigning = this.signingLock.acquire();
    } catch (cause) {
      error = this.protocolError(cause);
    }
    this.state.ledger[key] = {
      topic: request.topic,
      id: request.id,
      digest,
      expiresAt: params.expiresAt,
      wcExpiry: request.params.request.expiryTimestamp!,
      state: error ? 'terminal' : 'pending',
    };
    if (!error) this.claimed = key;
    try {
      await this.persist();
    } catch {
      if (this.claimed === key) this.claimed = undefined;
      this.releaseIfIdle();
      await this.sendError(
        request,
        new SSHProtocolError(SSH_ERROR_CODES.internalError),
      );
      return;
    }
    if (error) {
      await this.sendError(request, error);
      return;
    }
    try {
      this.assertAuthorization(value);
      parseSSHRequest(request);
    } catch (cause) {
      await this.finish(value, undefined, this.protocolError(cause));
      return;
    }
    runInAction(() => this.pending.set(key, value));
    this.timers.set(
      key,
      setTimeout(
        () => {
          void this.finish(
            value,
            undefined,
            new SSHProtocolError(SSH_ERROR_CODES.expired),
          ).catch(() => {});
        },
        Math.max(
          0,
          Math.min(
            params.expiresAt,
            this.kit.getActiveSessions()[request.topic].expiry,
          ) *
            1000 -
            Date.now(),
        ),
      ),
    );
  }

  assertPending(value: SSHWalletRequest): void {
    if (this.pending.get(keyOf(value.request)) !== value)
      throw new SSHProtocolError(SSH_ERROR_CODES.cancelled);
    this.assertAuthorization(value);
    const current = this.kit
      .getPendingSessionRequests()
      .find(
        request =>
          request.topic === value.request.topic &&
          request.id === value.request.id,
      );
    if (
      !current ||
      current.params.request.expiryTimestamp !==
        value.request.params.request.expiryTimestamp ||
      requestDigest(parseSSHRequest(current)) !== value.digest
    )
      throw new SSHProtocolError(SSH_ERROR_CODES.cancelled);
  }

  private assertAuthorization(value: SSHWalletRequest): void {
    if (this.storageFailed)
      throw new SSHProtocolError(SSH_ERROR_CODES.internalError);
    const {topic} = value.request;
    const session = this.kit.getActiveSessions()[topic];
    const authorization = this.state.authorizations[topic];
    if (
      !session ||
      session.expiry * 1000 <= Date.now() ||
      value.params.expiresAt * 1000 <= Date.now()
    )
      throw new SSHProtocolError(SSH_ERROR_CODES.expired);
    if (
      !authorization ||
      authorization.syncPending ||
      !authorization.desired.includes(value.params.account) ||
      !authorization.approved.includes(value.params.account) ||
      !getSSHSessionAccounts(session).includes(value.params.account) ||
      (authorization.generations[value.params.account] ?? 0) !==
        value.generation
    )
      throw new SSHProtocolError(SSH_ERROR_CODES.unauthorized);
  }

  async sign(
    value: SSHWalletRequest,
    operation: (assertActive: () => void) => Promise<string>,
  ): Promise<void> {
    this.assertPending(value);
    if (this.signing) throw new SSHProtocolError(SSH_ERROR_CODES.busy);
    this.signing = true;
    try {
      const signature = await operation(() => this.assertPending(value));
      this.assertPending(value);
      if (
        !verifySSHSignature(
          value.params.account,
          decodeBase64(value.params.data),
          decodeBase64(signature),
        )
      )
        throw new SSHProtocolError(SSH_ERROR_CODES.signingFailed);
      await this.finish(value, signature);
    } catch (error) {
      const failure = this.protocolError(error);
      await this.finish(value, undefined, failure);
      throw failure;
    } finally {
      this.signing = false;
      this.releaseIfIdle();
    }
  }

  reject(value: SSHWalletRequest): Promise<void> {
    return this.finish(
      value,
      undefined,
      new SSHProtocolError(SSH_ERROR_CODES.userRejected),
    );
  }

  cancel(value: SSHWalletRequest): Promise<void> {
    return this.finish(
      value,
      undefined,
      new SSHProtocolError(SSH_ERROR_CODES.cancelled),
    );
  }

  private finish(
    value: SSHWalletRequest,
    signature?: string,
    error?: SSHProtocolError,
  ): Promise<void> {
    const key = keyOf(value.request);
    const existing = this.completing.get(key);
    if (existing) return existing;
    if (this.state.ledger[key]?.state === 'terminal') return Promise.resolve();
    const operation = this.complete(value, signature, error);
    this.completing.set(key, operation);
    return operation.finally(() => this.completing.delete(key));
  }

  private async complete(
    value: SSHWalletRequest,
    signature?: string,
    error?: SSHProtocolError,
  ): Promise<void> {
    const key = keyOf(value.request);
    const signingResult = signature !== undefined;
    this.state.ledger[key].state = 'terminal';
    try {
      await this.persist();
      if (signature !== undefined) {
        try {
          this.assertPending(value);
        } catch (cause) {
          signature = undefined;
          error = this.protocolError(cause);
        }
      }
      // No await between the final authority check and handing the response to the SDK.
      await this.kit.respondSessionRequest({
        topic: value.request.topic,
        response:
          signature === undefined
            ? {
                id: value.request.id,
                jsonrpc: '2.0',
                error: {
                  code: (
                    error ?? new SSHProtocolError(SSH_ERROR_CODES.cancelled)
                  ).code,
                  message: (
                    error ?? new SSHProtocolError(SSH_ERROR_CODES.cancelled)
                  ).message,
                },
              }
            : {id: value.request.id, jsonrpc: '2.0', result: {signature}},
      });
      if (signingResult && signature === undefined)
        throw error ?? new SSHProtocolError(SSH_ERROR_CODES.cancelled);
    } finally {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
      runInAction(() => this.pending.delete(key));
      if (this.claimed === key) this.claimed = undefined;
      this.releaseIfIdle();
    }
  }

  private releaseIfIdle(): void {
    if (this.claimed || this.signing) return;
    this.releaseSigning?.();
    this.releaseSigning = undefined;
  }

  private cancelInvalid(topic: string): void {
    for (const value of this.pending.values()) {
      if (value.request.topic === topic) {
        try {
          this.assertAuthorization(value);
        } catch (error) {
          void this.finish(value, undefined, this.protocolError(error)).catch(
            () => {},
          );
        }
      }
    }
  }

  private async sendError(
    request: WalletKitTypes.SessionRequest,
    error: SSHProtocolError,
  ): Promise<void> {
    await this.kit.respondSessionRequest({
      topic: request.topic,
      response: {
        id: request.id,
        jsonrpc: '2.0',
        error: {code: error.code, message: error.message},
      },
    });
  }

  private protocolError(error: unknown): SSHProtocolError {
    return this.storageFailed
      ? new SSHProtocolError(SSH_ERROR_CODES.internalError)
      : error instanceof SSHProtocolError
        ? error
        : new SSHProtocolError(SSH_ERROR_CODES.signingFailed);
  }

  private persist(): Promise<void> {
    for (const [key, value] of Object.entries(this.state.ledger)) {
      if (
        value.wcExpiry * 1000 <= Date.now() &&
        !this.pending.has(key) &&
        this.claimed !== key
      )
        delete this.state.ledger[key];
    }
    const snapshot = structuredClone(this.state);
    const result = this.writing.then(() =>
      this.storage.set('sshWalletState', snapshot),
    );
    this.writing = result.catch(() => {
      this.storageFailed = true;
    });
    return result;
  }

  static async create(
    kit: IWalletKit,
    storage: StorageService,
    candidates: SSHKeyCandidates = () => [],
  ): Promise<SSHWalletService> {
    const stored = await storage.get('sshWalletState');
    if (stored && (!stored.authorizations || !stored.ledger))
      throw new Error('SSH signing state is unreadable.');
    return new SSHWalletService(kit, storage, stored, candidates);
  }
}
