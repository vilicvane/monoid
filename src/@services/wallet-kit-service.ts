import type {IWalletKit, WalletKitTypes} from '@reown/walletkit';
import {PAIRING_EVENTS} from '@walletconnect/core';
import {getSdkError, parseUri} from '@walletconnect/utils';
import {observable, reaction, runInAction} from 'mobx';
import ms from 'ms';

import {
  buildWalletConnectNamespaces,
  parseWalletConnectUri,
} from '../@lib/wallet-connect.js';

import type {StorageService} from './storage-service.js';

const CONNECTION_REQUEST_TIMEOUT = ms('1m');

export type WalletKitSession = Awaited<
  ReturnType<IWalletKit['approveSession']>
>;

export function getWalletKitSessionAddresses(
  session: WalletKitSession,
): string[] {
  const addresses = new Map<string, string>();

  for (const namespace of Object.values(session.namespaces)) {
    for (const account of namespace.accounts) {
      const address = account.split(':')[2]!;
      const identity = address.toLowerCase();
      if (!addresses.has(identity)) addresses.set(identity, address);
    }
  }

  return Array.from(addresses.values());
}

export type WalletKitSessionRecord = {
  connectedAt: number;
  lastActivityAt: number;
  verified: WalletKitTypes.SessionProposal['verifyContext']['verified'];
};

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    walletKitSessionRecords: Record<string, WalletKitSessionRecord>;
  }
}

export class WalletKitService {
  readonly sessions = observable.map<string, WalletKitSession>([], {
    deep: false,
  });

  readonly proposals = observable.map<number, WalletKitTypes.SessionProposal>(
    [],
    {deep: false},
  );

  readonly sessionRecords = observable.map<string, WalletKitSessionRecord>([], {
    deep: false,
  });

  private connecting = false;
  private approvals = new Map<number, Promise<WalletKitSession | undefined>>();

  constructor(
    private kit: IWalletKit,
    storage: StorageService,
    records: Record<string, WalletKitSessionRecord> = {},
  ) {
    runInAction(() => this.sessionRecords.replace(records));
    this.refreshSessions();

    reaction(
      () => Object.fromEntries(this.sessionRecords),
      records => {
        storage.set('walletKitSessionRecords', records).catch(console.error);
      },
      {fireImmediately: true},
    );

    const events = kit.engine.signClient.events;
    const onSessionChanged = ({topic}: {topic: string}): void => {
      this.refreshSessions();
      this.recordActivity(topic);
    };

    events.on('session_update', onSessionChanged);
    events.on('session_extend', onSessionChanged);
    events.on('session_event', ({topic}) => this.recordActivity(topic));
    events.on('session_delete', ({topic}) => this.removeSession(topic));
    events.on('session_expire', ({topic}) => this.removeSession(topic));

    kit.on('session_request', ({topic, verifyContext}) => {
      this.recordActivity(topic, verifyContext.verified);
    });

    kit.on('proposal_expire', ({id}) => {
      runInAction(() => this.proposals.delete(id));
    });

    const onPairingEnded = ({topic}: {topic: string}): void => {
      runInAction(() => {
        for (const [id, proposal] of this.proposals) {
          if (proposal.params.pairingTopic === topic) this.proposals.delete(id);
        }
      });
    };

    kit.core.pairing.events.on(PAIRING_EVENTS.expire, onPairingEnded);
    kit.core.pairing.events.on(PAIRING_EVENTS.delete, onPairingEnded);
  }

  async reject(id: number): Promise<void> {
    const approval = this.approvals.get(id);
    if (approval) {
      try {
        await approval;
      } catch {
        // Approval errors belong to the caller; leaving still dismisses the request.
      }
    }

    const proposal = this.proposals.get(id);
    if (!proposal) return;

    runInAction(() => this.proposals.delete(id));

    if (proposal.params.expiryTimestamp * 1000 > Date.now()) {
      await this.kit.rejectSession({id, reason: getSdkError('USER_REJECTED')});
    }
  }

  approve(
    id: number,
    addresses: readonly string[],
  ): Promise<WalletKitSession | undefined> {
    const pending = this.approvals.get(id);
    if (pending) return pending;

    const approval = this.approveProposal(id, addresses).finally(() => {
      this.approvals.delete(id);
    });
    this.approvals.set(id, approval);

    return approval;
  }

  private async approveProposal(
    id: number,
    addresses: readonly string[],
  ): Promise<WalletKitSession | undefined> {
    const proposal = this.proposals.get(id);
    if (!proposal) return undefined;

    if (proposal.params.expiryTimestamp * 1000 <= Date.now()) {
      runInAction(() => this.proposals.delete(id));
      return undefined;
    }

    const namespaces = buildWalletConnectNamespaces(proposal, addresses);
    const connectedAt = Date.now();

    try {
      const session = await this.kit.approveSession({id, namespaces});

      runInAction(() => {
        this.proposals.delete(id);
        this.addSession(session, connectedAt, proposal.verifyContext.verified);
      });

      return session;
    } catch (error) {
      // Approval can fail after the SDK has already stored the new session.
      for (const session of Object.values(this.kit.getActiveSessions())) {
        if (
          !this.sessions.has(session.topic) &&
          session.pairingTopic === proposal.params.pairingTopic
        ) {
          this.addSession(
            session,
            connectedAt,
            proposal.verifyContext.verified,
          );
        }
      }

      this.refreshSessions();

      if (
        !this.proposals.has(id) ||
        proposal.params.expiryTimestamp * 1000 <= Date.now()
      ) {
        runInAction(() => this.proposals.delete(id));
        return undefined;
      }

      // The SDK may consume the proposal before a later approval step fails.
      const pending = Object.values(this.kit.getPendingSessionProposals());
      if (!pending.some(proposal => proposal.id === id)) {
        runInAction(() => this.proposals.delete(id));
      }

      throw error;
    }
  }

  async disconnect(topic: string): Promise<void> {
    if (!this.sessions.has(topic)) return;

    await this.kit.disconnectSession({
      topic,
      reason: getSdkError('USER_DISCONNECTED'),
    });

    this.removeSession(topic);
  }

  canSwitchAccount(topic: string): boolean {
    const namespace = this.sessions.get(topic)?.namespaces.eip155;
    return (
      !!namespace?.accounts.length &&
      namespace.events.includes('accountsChanged')
    );
  }

  async switchAccounts(
    topic: string,
    addresses: readonly string[],
    onWaitingForAcknowledgement?: () => void,
  ): Promise<void> {
    this.refreshSessions();
    const session = this.sessions.get(topic);
    if (!session) throw new Error('Session no longer available.');
    if (!this.canSwitchAccount(topic)) {
      throw new Error('This session does not support account switching.');
    }

    const identities = new Set<string>();
    const selected = addresses.filter(address => {
      const identity = address.toLowerCase();
      if (identities.has(identity)) return false;
      identities.add(identity);
      return true;
    });
    if (!selected.length) throw new Error('Choose at least one account.');

    const namespace = session.namespaces.eip155!;
    const chainId = namespace.accounts[0]!.split(':').slice(0, 2).join(':');
    const chains =
      namespace.chains ??
      Array.from(
        new Set(
          namespace.accounts.map(account =>
            account.split(':').slice(0, 2).join(':'),
          ),
        ),
      );
    const accounts = chains.flatMap(chain =>
      selected.map(address => `${chain}:${address}`),
    );

    try {
      const {acknowledged} = await this.kit.updateSession({
        topic,
        namespaces: {
          ...session.namespaces,
          eip155: {...namespace, accounts},
        },
      });
      onWaitingForAcknowledgement?.();
      await acknowledged();
    } finally {
      // The SDK can update or roll back its local state before acknowledgement.
      this.refreshSessions();
    }

    if (!this.sessions.has(topic))
      throw new Error('Session no longer available.');
    this.recordActivity(topic);

    await this.kit.emitSessionEvent({
      topic,
      chainId,
      event: {name: 'accountsChanged', data: selected},
    });
  }

  private refreshSessions(): void {
    runInAction(() => {
      this.sessions.replace(this.kit.getActiveSessions());

      for (const topic of this.sessionRecords.keys()) {
        if (!this.sessions.has(topic)) this.sessionRecords.delete(topic);
      }
    });
  }

  private addSession(
    session: WalletKitSession,
    connectedAt: number,
    verified: WalletKitSessionRecord['verified'],
  ): void {
    runInAction(() => {
      this.sessions.set(session.topic, session);
      this.sessionRecords.set(session.topic, {
        connectedAt,
        lastActivityAt: connectedAt,
        verified,
      });
    });
  }

  private removeSession(topic: string): void {
    runInAction(() => {
      this.sessions.delete(topic);
      this.sessionRecords.delete(topic);
    });
  }

  private recordActivity(
    topic: string,
    verified?: WalletKitSessionRecord['verified'],
  ): void {
    if (!this.sessions.has(topic)) return;

    const record = this.sessionRecords.get(topic)!;

    runInAction(() => {
      this.sessionRecords.set(topic, {
        ...record,
        lastActivityAt: Date.now(),
        verified: verified ?? record.verified,
      });
    });
  }

  static async create(
    kit: IWalletKit,
    storage: StorageService,
  ): Promise<WalletKitService> {
    const records = await storage.get('walletKitSessionRecords');
    return new WalletKitService(kit, storage, records ?? {});
  }

  async connect(
    value: string,
    signal: AbortSignal,
  ): Promise<WalletKitTypes.SessionProposal | undefined> {
    if (signal.aborted) return undefined;

    const uri = parseWalletConnectUri(value);

    if (!uri) {
      throw new Error('Invalid or expired WalletConnect QR code.');
    }

    if (this.connecting) {
      throw new Error('A connection request is already in progress.');
    }

    const {topic, expiryTimestamp} = parseUri(uri);
    const pairingEvents = this.kit.core.pairing.events;

    this.connecting = true;

    try {
      return await new Promise<WalletKitTypes.SessionProposal | undefined>(
        (resolve, reject) => {
          let settled = false;
          let paired = false;
          let pendingProposal: WalletKitTypes.SessionProposal | undefined;

          const dispose = (): boolean => {
            if (settled) return false;

            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
            this.kit.off('session_proposal', onProposal);
            pairingEvents.off(PAIRING_EVENTS.expire, onPairingEnded);
            pairingEvents.off(PAIRING_EVENTS.delete, onPairingEnded);

            return true;
          };

          const fail = (error: unknown): void => {
            if (dispose()) reject(error);
          };

          const cancel = (): void => {
            if (dispose()) resolve(undefined);
          };

          const complete = (): void => {
            if (!paired || !pendingProposal) return;

            if (pendingProposal.params.expiryTimestamp * 1000 <= Date.now()) {
              fail(new Error('Connection request expired. Please scan again.'));
            } else if (dispose()) {
              runInAction(() => {
                this.proposals.set(pendingProposal!.id, pendingProposal!);
              });
              resolve(pendingProposal);
            }
          };

          const onProposal = (
            proposal: WalletKitTypes.SessionProposal,
          ): void => {
            if (proposal.params.pairingTopic !== topic) return;

            pendingProposal = proposal;
            complete();
          };

          const onPairingEnded = (event: {topic: string}): void => {
            if (event.topic === topic) {
              fail(new Error('Connection request ended. Please scan again.'));
            }
          };

          const timer = setTimeout(
            () => {
              fail(
                new Error('Connection request timed out. Please scan again.'),
              );
            },
            Math.min(
              CONNECTION_REQUEST_TIMEOUT,
              expiryTimestamp
                ? expiryTimestamp * 1000 - Date.now()
                : CONNECTION_REQUEST_TIMEOUT,
            ),
          );

          this.kit.on('session_proposal', onProposal);
          pairingEvents.on(PAIRING_EVENTS.expire, onPairingEnded);
          pairingEvents.on(PAIRING_EVENTS.delete, onPairingEnded);
          signal.addEventListener('abort', cancel, {once: true});

          // The SDK cannot abort pair(). Cancel only this wait; its temporary
          // pairing expires in the SDK, and any late rejection is still handled.
          void this.kit.pair({uri}).then(() => {
            paired = true;
            complete();
          }, fail);
        },
      );
    } finally {
      this.connecting = false;
    }
  }
}
