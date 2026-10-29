import {
  SSH_CHAIN_ID,
  SSH_METADATA_METHOD,
  SSH_METHOD,
} from '@monoid/ssh-protocol';
import type {IWalletKit, WalletKitTypes} from '@reown/walletkit';
import {base58, base64} from '@scure/base';
import {PAIRING_EVENTS, RELAYER_EVENTS} from '@walletconnect/core';
import {
  getAccountsChains,
  getSdkError,
  parseAccountId,
  parseUri,
} from '@walletconnect/utils';
import {type Provider, Transaction, hexlify, recoverAddress} from 'ethers';
import {observable, reaction, runInAction} from 'mobx';
import ms from 'ms';

import {
  type EvmCalldata,
  getEvmCalldataAddresses,
  getEvmCalldataCalls,
} from '../@lib/evm-calldata.js';
import {
  type SolanaSendOptions,
  getSignedSolanaTransactionSignature,
  sendSolanaTransaction,
} from '../@lib/send-solana-transaction.js';
import {SolanaRPCError} from '../@lib/solana-rpc.js';
import {verifySolanaSignature} from '../@lib/solana-signature.js';
import type {SolanaRPCRequest} from '../@lib/solana-transaction-review.js';
import {
  addSolanaTransactionSignature,
  parseSolanaTransaction,
} from '../@lib/solana-transaction.js';
import {getSSHSessionAccounts} from '../@lib/ssh-request.js';
import {getTypedDataAddresses} from '../@lib/typed-data-fields.js';
import {normalizeWalletAddress} from '../@lib/wallet-address.js';
import {
  type WalletConnectAuthenticationResult,
  buildWalletConnectAuthentication,
  getWalletConnectRequestExpiry,
  validateWalletConnectAuthentication,
} from '../@lib/wallet-connect-authentication.js';
import {
  WalletConnectRequestError,
  type WalletConnectSolanaTransactionRequest,
  parseWalletConnectSignRequest,
  parseWalletConnectSolanaTransactionRequest,
  parseWalletConnectTransactionRequest,
} from '../@lib/wallet-connect-request.js';
import {
  assertWalletConnectTransaction,
  getEvmTransactionAddresses,
} from '../@lib/wallet-connect-transaction.js';
import {
  WALLET_CONNECT_ADDRESS_TYPES,
  type WalletConnectAddressType,
  buildWalletConnectNamespaces,
  getWalletConnectAddressType,
  parseWalletConnectUri,
} from '../@lib/wallet-connect.js';
import {getSolanaSignatureStatus} from '../@lib/watch-solana-transaction.js';

import type {AddressBookService} from './address-book-service.js';
import type {EvmCallHistoryService} from './evm-call-history-service.js';
import type {SolanaTransactionHistoryService} from './solana-transaction-history-service.js';
import type {SSHKeyCandidates} from './ssh-key-store.js';
import {SSHWalletService} from './ssh-wallet-service.js';
import type {StorageService} from './storage-service.js';
import type {TransactionHistoryService} from './transaction-history-service.js';
import type {WalletConnectSigningLock} from './wallet-connect-signing-lock.js';

const CONNECTION_REQUEST_TIMEOUT = ms('1m');

export type WalletKitSession = Awaited<
  ReturnType<IWalletKit['approveSession']>
>;

export function getWalletKitSessionAddresses(
  session: WalletKitSession,
  switchable = false,
): string[] {
  const addresses = new Map<string, string>();

  for (const [, namespace] of getSessionNamespaces(session, switchable)) {
    for (const account of namespace.accounts) {
      const {namespace: name, address} = parseAccountId(account);
      const identity = `${name}:${name === 'eip155' ? normalizeWalletAddress(address) : address}`;
      if (!addresses.has(identity))
        addresses.set(identity, name === 'monoid' ? account : address);
    }
  }

  return Array.from(addresses.values());
}

export function getWalletKitSessionAddressTypes(
  session: WalletKitSession,
  switchable = false,
): WalletConnectAddressType[] {
  return Array.from(
    new Set(
      getSessionNamespaces(session, switchable).flatMap(([name]) => {
        const type = getNamespaceAddressType(name);
        return type ? [type] : [];
      }),
    ),
  );
}

function getSessionNamespaces(
  session: WalletKitSession,
  switchable: boolean,
): [string, WalletKitSession['namespaces'][string]][] {
  return Object.entries(session.namespaces).filter(
    ([name, namespace]) =>
      !switchable ||
      (getNamespaceAddressType(name) !== undefined &&
        namespace.accounts.length > 0 &&
        namespace.events.includes('accountsChanged')),
  );
}

function getNamespaceAddressType(
  name: string,
): WalletConnectAddressType | undefined {
  return Object.entries(WALLET_CONNECT_ADDRESS_TYPES).find(
    ([namespace]) => namespace === name.split(':')[0],
  )?.[1];
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

export type WalletKitSolanaTransactionSubmission = {
  topic: string;
  chainId: string;
  address: string;
  transaction: string;
  signedTransaction: string;
  sendOptions: SolanaSendOptions;
  broadcast: boolean;
  timestamp: number;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    walletKitSessionRecords: Record<string, WalletKitSessionRecord>;
    walletKitTransactionSubmissions: Record<
      string,
      WalletKitTransactionSubmission
    >;
    walletKitSolanaTransactionSubmissions: Record<
      string,
      WalletKitSolanaTransactionSubmission
    >;
  }
}

export class WalletKitService {
  readonly ssh: SSHWalletService;
  readonly signingLock: WalletConnectSigningLock;
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
  private approvingSSH = new Map<number, string>();
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
  private solanaTransactionSubmissions = observable.map<
    number,
    WalletKitSolanaTransactionSubmission
  >([], {deep: false});
  private writingSolanaSubmissions = Promise.resolve();
  private recordedSolanaSubmissions = new Set<number>();

  constructor(
    private kit: IWalletKit,
    private storage: StorageService,
    private addressBook: AddressBookService,
    private callHistory: EvmCallHistoryService,
    private transactionHistory: TransactionHistoryService,
    private solanaTransactionHistory: SolanaTransactionHistoryService,
    records: Record<string, WalletKitSessionRecord> = {},
    submissions: StorageMapping['walletKitTransactionSubmissions'] = {},
    solanaSubmissions: StorageMapping['walletKitSolanaTransactionSubmissions'] = {},
    ssh?: SSHWalletService,
    private isSigningBusy: () => boolean = () => false,
    sshCandidates: SSHKeyCandidates = () => [],
  ) {
    this.ssh =
      ssh ?? new SSHWalletService(kit, storage, undefined, sshCandidates);
    this.signingLock = this.ssh.signingLock;
    runInAction(() => {
      this.sessionRecords.replace(records);
      this.transactionSubmissions.replace(
        Object.entries(submissions).map(([id, submission]) => [
          Number(id),
          submission,
        ]),
      );
      this.solanaTransactionSubmissions.replace(
        Object.entries(solanaSubmissions).map(([id, submission]) => [
          Number(id),
          submission,
        ]),
      );
      // create() restores accepted submissions to history before cleanup can run.
      for (const [id, submission] of this.solanaTransactionSubmissions) {
        if (submission.broadcast) this.recordedSolanaSubmissions.add(id);
      }
    });
    this.refreshSessions();

    reaction(
      () => [...this.ssh.pending.values()],
      () => this.refreshRequests(),
    );

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
    kit.core.relayer.on(RELAYER_EVENTS.connect, () =>
      this.ssh.notifyMetadataChanged(),
    );

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

  approveSolanaTransactionRequest(
    id: number,
    topic: string,
    payload: WalletConnectSolanaTransactionRequest,
    signed: {address: string; signature: string}[],
    rpc?: SolanaRPCRequest,
  ): Promise<boolean> {
    return this.withRequestResponse(id, () =>
      this.sendSolanaTransactionResponse(id, topic, payload, signed, rpc),
    );
  }

  getSolanaTransactionSubmission(
    id: number,
  ): WalletKitSolanaTransactionSubmission | undefined {
    return this.solanaTransactionSubmissions.get(id);
  }

  resumeSolanaTransactionRequest(
    id: number,
    topic: string,
    rpc?: SolanaRPCRequest,
  ): Promise<boolean> {
    const submission = this.solanaTransactionSubmissions.get(id);
    if (!submission) throw new Error('No signed transaction is available.');
    const transaction = parseSolanaTransaction(submission.signedTransaction);
    const {address, chainId, sendOptions} = submission;
    const signature = base58.encode(
      transaction.signatures[transaction.signerAddresses.indexOf(address)],
    );

    return this.approveSolanaTransactionRequest(
      id,
      topic,
      {
        method: 'solana_signAndSendTransaction',
        chainId,
        sendOptions,
        transactions: [
          {
            transaction: parseSolanaTransaction(submission.transaction),
            addresses: [address],
          },
        ],
      },
      [{address, signature}],
      rpc,
    );
  }

  async rejectRequest(id: number): Promise<void> {
    if (
      this.transactionSubmissions.has(id) ||
      this.solanaTransactionSubmissions.has(id)
    ) {
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

    await this.transactionHistory.rememberSubmitted(signedTransaction);

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

    let solanaChanged = false;
    runInAction(() => {
      for (const [id, submission] of this.solanaTransactionSubmissions) {
        if (
          !this.requests.has(id) &&
          !this.responses.has(id) &&
          (!submission.broadcast || this.recordedSolanaSubmissions.has(id))
        ) {
          this.solanaTransactionSubmissions.delete(id);
          this.recordedSolanaSubmissions.delete(id);
          solanaChanged = true;
        }
      }
    });
    if (solanaChanged)
      void this.saveSolanaTransactionSubmissions().catch(console.error);
  }

  private saveSolanaTransactionSubmissions(): Promise<void> {
    this.writingSolanaSubmissions = this.writingSolanaSubmissions
      .catch(() => {})
      .then(async () => {
        await this.storage.set(
          'walletKitSolanaTransactionSubmissions',
          Object.fromEntries(this.solanaTransactionSubmissions),
        );
      });
    return this.writingSolanaSubmissions;
  }

  private async sendRequestResponse(
    id: number,
    signature?: string,
  ): Promise<boolean> {
    this.refreshSessions();
    const request = this.requests.get(id);
    if (!request) return false;

    let result: string | {signature: string} | undefined = signature;
    if (signature !== undefined) {
      const payload = parseWalletConnectSignRequest(
        request,
        this.sessions.get(request.topic)!,
      );
      const valid =
        payload.method === 'solana_signMessage'
          ? verifySolanaSignature(payload.message, signature, payload.address)
          : recoverAddress(payload.digest, signature).toLowerCase() ===
            payload.address.toLowerCase();
      if (!valid) {
        throw new Error('The signature does not match the requested account.');
      }

      if (payload.method === 'solana_signMessage') result = {signature};

      // The signature is complete even if publishing its response needs a retry.
      if (payload.method === 'eth_signTypedData_v4') {
        void this.addressBook
          .rememberSigned('evm', getTypedDataAddresses(payload.typedData))
          .catch(console.error);
      }
    }

    return this.publishRequestResponse(request, result);
  }

  private prepareSolanaTransactionResponse(
    id: number,
    topic: string,
    reviewed: WalletConnectSolanaTransactionRequest,
    signed: {address: string; signature: string}[],
  ):
    | {
        request: WalletKitTypes.SessionRequest;
        payload: WalletConnectSolanaTransactionRequest;
        transactions: string[];
      }
    | undefined {
    this.refreshSessions();
    const request = this.requests.get(id);
    if (!request) return undefined;
    if (request.topic !== topic) {
      throw new WalletConnectRequestError(
        'This session is not authorized.',
        4100,
      );
    }

    const payload = parseWalletConnectSolanaTransactionRequest(
      request,
      this.sessions.get(request.topic)!,
    );

    if (
      payload.method !== reviewed.method ||
      payload.chainId !== reviewed.chainId ||
      (payload.method === 'solana_signAndSendTransaction' &&
        reviewed.method === 'solana_signAndSendTransaction' &&
        JSON.stringify(payload.sendOptions) !==
          JSON.stringify(reviewed.sendOptions)) ||
      payload.transactions.length !== reviewed.transactions.length ||
      payload.transactions.some(
        ({transaction}, index) =>
          hexlify(transaction.bytes) !==
          hexlify(reviewed.transactions[index].transaction.bytes),
      )
    ) {
      throw new Error('The transaction no longer matches the request.');
    }

    if (signed.length !== payload.transactions.length) {
      throw new Error(
        'The signatures do not match the requested transactions.',
      );
    }

    const transactions = payload.transactions.map(
      ({transaction, addresses}, index) => {
        const {address, signature} = signed[index];

        if (
          !addresses.includes(address) ||
          !reviewed.transactions[index].addresses.includes(address)
        ) {
          throw new WalletConnectRequestError(
            'This transaction signer is not authorized.',
            4100,
          );
        }

        return addSolanaTransactionSignature(transaction, address, signature);
      },
    );

    return {request, payload, transactions};
  }

  private async sendSolanaTransactionResponse(
    id: number,
    topic: string,
    reviewed: WalletConnectSolanaTransactionRequest,
    signed: {address: string; signature: string}[],
    rpc?: SolanaRPCRequest,
  ): Promise<boolean> {
    const validate = (): ReturnType<
      WalletKitService['prepareSolanaTransactionResponse']
    > => this.prepareSolanaTransactionResponse(id, topic, reviewed, signed);
    const prepared = validate();
    if (!prepared) return false;
    const {request, payload, transactions} = prepared;

    if (payload.method === 'solana_signAndSendTransaction') {
      const signedTransaction = transactions[0];
      const signature = getSignedSolanaTransactionSignature(signedTransaction);
      let submission = this.solanaTransactionSubmissions.get(id);
      const resuming = submission !== undefined;
      if (
        submission &&
        (submission.topic !== topic ||
          submission.chainId !== payload.chainId ||
          submission.address !== signed[0].address ||
          submission.signedTransaction !== signedTransaction ||
          JSON.stringify(submission.sendOptions) !==
            JSON.stringify(payload.sendOptions))
      ) {
        throw new Error('Retry the transaction that was already submitted.');
      }
      if (!submission) {
        submission = {
          topic,
          chainId: payload.chainId,
          address: signed[0].address,
          transaction: base64.encode(payload.transactions[0].transaction.bytes),
          signedTransaction,
          sendOptions: payload.sendOptions,
          broadcast: false,
          timestamp: Date.now(),
        };
        runInAction(() =>
          this.solanaTransactionSubmissions.set(id, submission!),
        );
      }

      // Persist the same bytes for retries, including after a lost RPC response.
      await this.saveSolanaTransactionSubmissions();
      if (!submission.broadcast) {
        if (!rpc)
          throw new Error('Connect to the network to retry this transaction.');
        const isAccepted = async (): Promise<boolean> =>
          (await getSolanaSignatureStatus(rpc, signature)) !== null;
        if (!(await isAccepted())) {
          if (!validate()) return false;
          try {
            await sendSolanaTransaction(
              signedTransaction,
              rpc,
              payload.sendOptions,
            );
          } catch (error) {
            if (!(await isAccepted().catch(() => false))) {
              // A preflight refusal never broadcasts this attempt. A retry may
              // still follow an earlier broadcast whose response was lost.
              if (
                !resuming &&
                error instanceof SolanaRPCError &&
                error.code === -32002
              ) {
                runInAction(() => this.solanaTransactionSubmissions.delete(id));
                await this.saveSolanaTransactionSubmissions();
              }
              throw error;
            }
          }
        }
        submission = {...submission, broadcast: true};
      }

      // Establish history before publishing broadcast state: the result view
      // can receive confirmation before either storage write has completed.
      const remember = this.solanaTransactionHistory.rememberSubmitted(
        submission.chainId,
        submission.address,
        submission.signedTransaction,
        submission.timestamp,
      );
      if (this.solanaTransactionSubmissions.get(id) !== submission) {
        runInAction(() =>
          this.solanaTransactionSubmissions.set(id, submission!),
        );
        await Promise.all([remember, this.saveSolanaTransactionSubmissions()]);
      } else {
        await remember;
      }
      this.recordedSolanaSubmissions.add(id);

      if (!validate()) return false;
      return this.publishRequestResponse(request, {signature});
    }

    const timestamp = Date.now();
    await Promise.all(
      transactions.map(async (transaction, index) =>
        this.solanaTransactionHistory.rememberSigned(
          payload.chainId,
          signed[index].address,
          transaction,
          timestamp,
        ),
      ),
    );
    if (!validate()) return false;

    return this.publishRequestResponse(
      request,
      payload.method === 'solana_signTransaction'
        ? {signature: signed[0].signature, transaction: transactions[0]}
        : {transactions},
    );
  }

  private async publishRequestResponse(
    request: WalletKitTypes.SessionRequest,
    result?:
      | string
      | {signature: string; transaction?: string}
      | {transactions: string[]},
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
    const ssh = getSSHSessionAccounts({namespaces}).length > 0;
    if (ssh) this.approvingSSH.set(id, proposal.params.pairingTopic);

    try {
      const session = await this.kit.approveSession({
        id,
        namespaces,
        ...(authentication.length && {
          proposalRequestsResponses: {authentication},
        }),
      });

      try {
        if (ssh) await this.ssh.registerSession(session);
      } catch (error) {
        await this.kit.disconnectSession({
          topic: session.topic,
          reason: getSdkError('USER_DISCONNECTED'),
        });
        throw error;
      }

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
    } finally {
      if (ssh) {
        this.approvingSSH.delete(id);
        // The peer may send its first request before approveSession returns.
        // Admit it only after our authorization has been durably registered.
        this.refreshSessions();
      }
    }
  }

  async disconnect(topic: string): Promise<void> {
    this.ssh.invalidateSession(topic);
    if (!this.sessions.has(topic)) return;

    await this.kit.disconnectSession({
      topic,
      reason: getSdkError('USER_DISCONNECTED'),
    });

    this.removeSession(topic);
  }

  canSwitchAccount(topic: string): boolean {
    const session = this.sessions.get(topic);
    return (
      !!session &&
      (getSessionNamespaces(session, true).length > 0 ||
        getSSHSessionAccounts(session).length > 0)
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

    if (getSSHSessionAccounts(session).length) {
      const selected = [...new Set(addresses)];
      if (
        !selected.length ||
        selected.some(account => !account.startsWith(`${SSH_CHAIN_ID}:`))
      )
        throw new Error('Choose at least one SSH key.');
      const revision = await this.ssh.beginSwitch(topic, selected);
      const namespaces = {...session.namespaces};
      const name = namespaces.monoid ? 'monoid' : SSH_CHAIN_ID;
      namespaces[name] = {...namespaces[name], accounts: selected};
      try {
        const {acknowledged} = await this.kit.updateSession({
          topic,
          namespaces,
        });
        const acknowledgement = acknowledged();
        onWaitingForAcknowledgement?.();
        await acknowledgement;
        await this.ssh.acknowledgeSwitch(topic, revision);
      } finally {
        this.refreshSessions();
      }
      await this.kit.emitSessionEvent({
        topic,
        chainId: SSH_CHAIN_ID,
        event: {
          name: 'accountsChanged',
          data: selected.map(account => account.slice(SSH_CHAIN_ID.length + 1)),
        },
      });
      return;
    }

    const identities = new Set<string>();
    const types = getWalletKitSessionAddressTypes(session, true);
    const selected = addresses.filter(address => {
      const type = getWalletConnectAddressType(address);
      if (!type || !types.includes(type)) {
        throw new Error('This account is not supported by the session.');
      }
      const identity = normalizeWalletAddress(address);
      if (identities.has(identity)) return false;
      identities.add(identity);
      return true;
    });
    if (!selected.length) throw new Error('Choose at least one account.');

    const namespaces = {...session.namespaces};
    const events = getSessionNamespaces(session, true).map(
      ([name, namespace]) => {
        const type = getNamespaceAddressType(name)!;
        const accounts = selected.filter(
          address => getWalletConnectAddressType(address) === type,
        );
        if (!accounts.length) {
          throw new Error('Choose at least one account for each network.');
        }
        const accountChains = Array.from(
          new Set(getAccountsChains(namespace.accounts)),
        );
        const chains = namespace.chains ?? accountChains;

        namespaces[name] = {
          ...namespace,
          accounts: chains.flatMap(chain =>
            accounts.map(address => `${chain}:${address}`),
          ),
        };

        return {chainId: accountChains[0]!, accounts};
      },
    );

    try {
      const {acknowledged} = await this.kit.updateSession({
        topic,
        namespaces,
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

    for (const {chainId, accounts} of events) {
      await this.kit.emitSessionEvent({
        topic,
        chainId,
        event: {name: 'accountsChanged', data: accounts},
      });
    }
  }

  private refreshSessions(): void {
    runInAction(() => {
      this.sessions.replace(this.kit.getActiveSessions());

      for (const topic of this.sessionRecords.keys()) {
        if (!this.sessions.has(topic)) this.sessionRecords.delete(topic);
      }

      this.refreshRequests();
    });
    this.ssh.refresh();
  }

  private refreshRequests(): void {
    const now = Date.now();
    const pending = this.kit.getPendingSessionRequests();
    const approvingPairings = new Set(this.approvingSSH.values());
    const sessions = this.kit.getActiveSessions();
    for (const request of pending) {
      if (request.params.request.method === SSH_METADATA_METHOD) {
        // Read-only metadata neither waits for nor occupies an approval slot.
        void this.ssh.receive(request).catch(() => {});
        continue;
      }
      if (
        request.params.request.method === SSH_METHOD ||
        request.params.chainId === SSH_CHAIN_ID
      ) {
        if (approvingPairings.has(sessions[request.topic]?.pairingTopic))
          continue;
        void this.ssh
          .receive(
            request,
            this.isSigningBusy() ||
              pending.some(
                other =>
                  other.params.request.method !== SSH_METHOD &&
                  other.params.request.method !== SSH_METADATA_METHOD &&
                  other.params.chainId !== SSH_CHAIN_ID,
              ),
          )
          .catch(() => {});
      }
    }

    runInAction(() => {
      this.requests.replace(
        [
          ...pending.filter(
            request =>
              request.params.request.method !== SSH_METHOD &&
              request.params.request.method !== SSH_METADATA_METHOD &&
              request.params.chainId !== SSH_CHAIN_ID,
          ),
          ...[...this.ssh.pending.values()].map(value => value.request),
        ]
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
    this.ssh.invalidateSession(topic);
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
    transactionHistory: TransactionHistoryService,
    solanaTransactionHistory: SolanaTransactionHistoryService,
    isSigningBusy: () => boolean = () => false,
    sshCandidates: SSHKeyCandidates = () => [],
  ): Promise<WalletKitService> {
    const [records, submissions, solanaSubmissions, ssh] = await Promise.all([
      storage.get('walletKitSessionRecords'),
      storage.get('walletKitTransactionSubmissions'),
      storage.get('walletKitSolanaTransactionSubmissions'),
      SSHWalletService.create(kit, storage, sshCandidates),
    ]);
    // A crash after broadcast must not let request cleanup discard its history.
    for (const submission of Object.values(solanaSubmissions ?? {})) {
      if (submission.broadcast) {
        await solanaTransactionHistory.rememberSubmitted(
          submission.chainId,
          submission.address,
          submission.signedTransaction,
          submission.timestamp,
        );
      }
    }
    return new WalletKitService(
      kit,
      storage,
      addressBook,
      callHistory,
      transactionHistory,
      solanaTransactionHistory,
      records ?? {},
      submissions ?? {},
      solanaSubmissions ?? {},
      ssh,
      isSigningBusy,
      sshCandidates,
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
