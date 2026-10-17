import type {IWalletKit, WalletKitTypes} from '@reown/walletkit';
import {PAIRING_EVENTS} from '@walletconnect/core';
import {getSdkError, parseUri} from '@walletconnect/utils';
import {type Provider, Transaction, recoverAddress} from 'ethers';
import {observable, reaction, runInAction} from 'mobx';
import ms from 'ms';

import {
  type EvmCalldata,
  getEvmCalldataAddresses,
  getEvmCalldataCalls,
} from '../@lib/evm-calldata.js';
import {getTypedDataAddresses} from '../@lib/typed-data-fields.js';
import {
  type WalletConnectAuthenticationResult,
  buildWalletConnectAuthentication,
  getWalletConnectRequestExpiry,
  validateWalletConnectAuthentication,
} from '../@lib/wallet-connect-authentication.js';
import {
  WalletConnectRequestError,
  parseWalletConnectSignRequest,
  parseWalletConnectTransactionRequest,
} from '../@lib/wallet-connect-request.js';
import {
  assertWalletConnectTransaction,
  getEvmTransactionAddresses,
} from '../@lib/wallet-connect-transaction.js';
import {
  buildWalletConnectNamespaces,
  parseWalletConnectUri,
} from '../@lib/wallet-connect.js';

import type {AddressBookService} from './address-book-service.js';
import type {EvmCallHistoryService} from './evm-call-history-service.js';
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

export type WalletKitTransactionSubmission = {
  topic: string;
  signedTransaction: string;
  broadcast: boolean;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    walletKitSessionRecords: Record<string, WalletKitSessionRecord>;
    walletKitTransactionSubmissions: Record<
      string,
      WalletKitTransactionSubmission
    >;
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

  readonly requests = observable.map<number, WalletKitTypes.SessionRequest>(
    [],
    {deep: false},
  );

  readonly sessionRecords = observable.map<string, WalletKitSessionRecord>([], {
    deep: false,
  });

  private connecting = false;
  private approvals = new Map<number, Promise<WalletKitSession | undefined>>();
  private responses = observable.map<number, Promise<boolean>>([], {
    deep: false,
  });
  private transactionSubmissions = observable.map<
    number,
    WalletKitTransactionSubmission
  >([], {
    deep: false,
  });
  private writingSubmissions = Promise.resolve();

  constructor(
    private kit: IWalletKit,
    private storage: StorageService,
    private addressBook: AddressBookService,
    private callHistory: EvmCallHistoryService,
    records: Record<string, WalletKitSessionRecord> = {},
    submissions: StorageMapping['walletKitTransactionSubmissions'] = {},
  ) {
    runInAction(() => {
      this.sessionRecords.replace(records);
      this.transactionSubmissions.replace(
        Object.entries(submissions).map(([id, submission]) => [
          Number(id),
          submission,
        ]),
      );
    });
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
      this.refreshRequests();
    });

    kit.on('session_request_expire', ({id}) => {
      runInAction(() => this.requests.delete(id));
      this.clearFinishedTransactionSubmissions();
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

  approveRequest(id: number, signature: string): Promise<boolean> {
    return this.respondRequest(id, signature);
  }

  async rejectRequest(id: number): Promise<void> {
    if (this.transactionSubmissions.has(id)) {
      await this.responses.get(id);
      return;
    }
    await this.respondRequest(id);
  }

  getTransactionSubmission(
    id: number,
  ): WalletKitTransactionSubmission | undefined {
    return this.transactionSubmissions.get(id);
  }

  approveTransactionRequest(
    id: number,
    topic: string,
    unsignedTransaction: string,
    signature: string,
    provider?: Provider,
    decodedData?: EvmCalldata,
  ): Promise<boolean> {
    return this.withRequestResponse(id, () =>
      this.sendTransactionResponse(
        id,
        topic,
        unsignedTransaction,
        signature,
        provider,
        decodedData,
      ),
    );
  }

  isRespondingToRequest(id: number): boolean {
    return this.responses.has(id);
  }

  private respondRequest(id: number, signature?: string): Promise<boolean> {
    return this.withRequestResponse(id, () =>
      this.sendRequestResponse(id, signature),
    );
  }

  private withRequestResponse(
    id: number,
    send: () => Promise<boolean>,
  ): Promise<boolean> {
    const pending = this.responses.get(id);
    if (pending) return pending;

    // Register before refreshing observable state, so leaving the page cannot
    // send a rejection while its signed response is being published.
    const response = Promise.resolve()
      .then(send)
      .finally(() => {
        runInAction(() => this.responses.delete(id));
        this.clearFinishedTransactionSubmissions();
      });
    runInAction(() => this.responses.set(id, response));

    return response;
  }

  private async sendTransactionResponse(
    id: number,
    topic: string,
    unsignedTransaction: string,
    signature: string,
    provider?: Provider,
    decodedData?: EvmCalldata,
  ): Promise<boolean> {
    this.refreshSessions();
    const request = this.requests.get(id);
    if (!request) return false;
    if (request.topic !== topic) {
      throw new WalletConnectRequestError(
        'This session is not authorized.',
        4100,
      );
    }

    const validate = (): Transaction => {
      const current = this.requests.get(id)!;
      if (current.topic !== request.topic) {
        throw new Error('The transaction no longer matches the request.');
      }
      const payload = parseWalletConnectTransactionRequest(
        current,
        this.sessions.get(current.topic)!,
      );
      assertWalletConnectTransaction(payload, unsignedTransaction);
      const transaction = Transaction.from(unsignedTransaction);
      transaction.signature = signature;
      if (transaction.from!.toLowerCase() !== payload.address.toLowerCase()) {
        throw new Error('The signature does not match the requested account.');
      }
      return transaction;
    };
    const transaction = validate();
    if (
      decodedData &&
      (decodedData.data !== transaction.data ||
        decodedData.target?.toLowerCase() !== transaction.to?.toLowerCase())
    ) {
      throw new Error('The decoded data no longer matches the transaction.');
    }
    const signedTransaction = transaction.serialized;
    const hash = transaction.hash!;
    let submission = this.transactionSubmissions.get(id);
    if (
      submission &&
      (submission.topic !== request.topic ||
        submission.signedTransaction !== signedTransaction)
    ) {
      throw new Error('Retry the transaction that was already submitted.');
    }

    if (!submission) {
      submission = {topic: request.topic, signedTransaction, broadcast: false};
      runInAction(() => this.transactionSubmissions.set(id, submission!));
    }
    void this.addressBook
      .rememberSigned('evm', [
        ...getEvmTransactionAddresses(transaction),
        ...(decodedData ? getEvmCalldataAddresses(decodedData, true) : []),
      ])
      .catch(console.error);
    if (decodedData) {
      void this.callHistory
        .rememberSigned(
          `eip155:${transaction.chainId}`,
          getEvmCalldataCalls(decodedData),
        )
        .catch(console.error);
    }

    // Persist the exact signed bytes before any RPC can accept the transaction.
    await this.saveTransactionSubmissions();

    if (!submission.broadcast) {
      if (!provider)
        throw new Error('Connect to the network to retry this transaction.');
      const network = await provider.getNetwork();
      if (network.chainId !== transaction.chainId) {
        throw new Error('The RPC uses a different network.');
      }
      this.refreshSessions();
      if (!this.requests.has(id)) return false;
      validate();

      const isAccepted = async (): Promise<boolean> => {
        const known = await provider.getTransaction(hash);
        if (known && known.hash.toLowerCase() !== hash.toLowerCase()) {
          throw new Error('The RPC returned a different transaction hash.');
        }
        return known !== null;
      };
      const accepted = await isAccepted();
      if (!accepted) {
        this.refreshSessions();
        if (!this.requests.has(id)) return false;
        validate();
        try {
          const result = await provider.broadcastTransaction(signedTransaction);
          if (result.hash.toLowerCase() !== hash.toLowerCase()) {
            throw new Error('The RPC returned a different transaction hash.');
          }
        } catch (error) {
          if (!(await isAccepted().catch(() => false))) throw error;
        }
      }
      submission = {...submission, broadcast: true};
      runInAction(() => this.transactionSubmissions.set(id, submission!));
      await this.saveTransactionSubmissions();
    }

    const responded = await this.publishRequestResponse(request, hash);
    if (responded || !this.requests.has(id)) {
      runInAction(() => this.transactionSubmissions.delete(id));
      await this.saveTransactionSubmissions().catch(console.error);
    }
    return responded;
  }

  private saveTransactionSubmissions(): Promise<void> {
    this.writingSubmissions = this.writingSubmissions
      .catch(() => {})
      .then(async () => {
        await this.storage.set(
          'walletKitTransactionSubmissions',
          Object.fromEntries(this.transactionSubmissions),
        );
      });
    return this.writingSubmissions;
  }

  private clearFinishedTransactionSubmissions(): void {
    let changed = false;
    runInAction(() => {
      for (const id of this.transactionSubmissions.keys()) {
        if (!this.requests.has(id) && !this.responses.has(id)) {
          this.transactionSubmissions.delete(id);
          changed = true;
        }
      }
    });
    if (changed) void this.saveTransactionSubmissions().catch(console.error);
  }

  private async sendRequestResponse(
    id: number,
    signature?: string,
  ): Promise<boolean> {
    this.refreshSessions();
    const request = this.requests.get(id);
    if (!request) return false;

    if (signature !== undefined) {
      const payload = parseWalletConnectSignRequest(
        request,
        this.sessions.get(request.topic)!,
      );
      if (
        recoverAddress(payload.digest, signature).toLowerCase() !==
        payload.address.toLowerCase()
      ) {
        throw new Error('The signature does not match the requested account.');
      }

      // The signature is complete even if publishing its response needs a retry.
      if (payload.method === 'eth_signTypedData_v4') {
        void this.addressBook
          .rememberSigned('evm', getTypedDataAddresses(payload.typedData))
          .catch(console.error);
      }
    }

    return this.publishRequestResponse(request, signature);
  }

  private async publishRequestResponse(
    request: WalletKitTypes.SessionRequest,
    result?: string,
  ): Promise<boolean> {
    const {id} = request;
    try {
      await this.kit.respondSessionRequest({
        topic: request.topic,
        response:
          result === undefined
            ? {id, jsonrpc: '2.0', error: getSdkError('USER_REJECTED')}
            : {id, jsonrpc: '2.0', result},
      });
      this.refreshSessions();
      this.recordActivity(request.topic);
      return true;
    } catch (error) {
      this.refreshSessions();
      const session = this.sessions.get(request.topic);

      if (
        !session ||
        session.expiry * 1000 <= Date.now() ||
        (request.params.request.expiryTimestamp ?? Infinity) * 1000 <=
          Date.now()
      ) {
        return false;
      }

      // The SDK only consumes a request after publishing its response. Do not
      // offer a retry if a later cleanup step failed after that point.
      if (!this.requests.has(id)) return true;

      throw error;
    }
  }

  approve(
    id: number,
    addresses: readonly string[],
    authentication: WalletConnectAuthenticationResult[] = [],
  ): Promise<WalletKitSession | undefined> {
    const pending = this.approvals.get(id);
    if (pending) return pending;

    const approval = this.approveProposal(
      id,
      addresses,
      authentication,
    ).finally(() => {
      this.approvals.delete(id);
    });
    this.approvals.set(id, approval);

    return approval;
  }

  private async approveProposal(
    id: number,
    addresses: readonly string[],
    authentication: WalletConnectAuthenticationResult[],
  ): Promise<WalletKitSession | undefined> {
    const proposal = this.proposals.get(id);
    if (!proposal) return undefined;

    if (getWalletConnectRequestExpiry(proposal) <= Date.now()) {
      runInAction(() => this.proposals.delete(id));
      return undefined;
    }

    const namespaces = buildWalletConnectNamespaces(proposal, addresses);
    validateWalletConnectAuthentication(
      buildWalletConnectAuthentication(proposal, addresses),
      authentication,
    );
    const connectedAt = Date.now();

    try {
      const session = await this.kit.approveSession({
        id,
        namespaces,
        ...(authentication.length && {
          proposalRequestsResponses: {authentication},
        }),
      });

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
        getWalletConnectRequestExpiry(proposal) <= Date.now()
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

      this.refreshRequests();
    });
  }

  private refreshRequests(): void {
    const now = Date.now();

    runInAction(() => {
      this.requests.replace(
        this.kit
          .getPendingSessionRequests()
          .filter(({topic, params}) => {
            const session = this.sessions.get(topic);
            const expiry = params.request.expiryTimestamp;
            return (
              session !== undefined &&
              !(session.expiry * 1000 <= now) &&
              (expiry === undefined || expiry * 1000 > now)
            );
          })
          .map(request => [request.id, request]),
      );
    });
    this.clearFinishedTransactionSubmissions();
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

      for (const [id, request] of this.requests) {
        if (request.topic === topic) this.requests.delete(id);
      }
    });
    this.clearFinishedTransactionSubmissions();
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
    addressBook: AddressBookService,
    callHistory: EvmCallHistoryService,
  ): Promise<WalletKitService> {
    const [records, submissions] = await Promise.all([
      storage.get('walletKitSessionRecords'),
      storage.get('walletKitTransactionSubmissions'),
    ]);
    return new WalletKitService(
      kit,
      storage,
      addressBook,
      callHistory,
      records ?? {},
      submissions ?? {},
    );
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
