import {base58, base64} from '@scure/base';
import {getBytes, sha256} from 'ethers';
import {observable, runInAction} from 'mobx';

import {getSignedSolanaTransactionSignature} from '../@lib/send-solana-transaction.js';
import type {SolanaTransactionBalances} from '../@lib/solana-transaction-balances.js';
import {parseSolanaTransaction} from '../@lib/solana-transaction.js';
import type {SolanaTransactionConfirmation} from '../@lib/watch-solana-transaction.js';

import type {StorageService} from './storage-service.js';

export type SolanaTransactionHistoryItem = {
  id: string;
  chainId: string;
  address: string;
  signature?: string;
  timestamp: number;
  status: 'signed' | 'not-found' | 'pending' | 'confirmed' | 'failed';
};

type Confirmation = Omit<
  Extract<SolanaTransactionConfirmation, {status: 'confirmed' | 'failed'}>,
  'error'
>;

export type SolanaTransactionHistoryDetail = {
  transaction: SolanaTransactionHistoryItem;
  signedTransaction: string;
  confirmation?: Confirmation;
};

type SavedBalances = {
  native?: {address: string; before: string; after: string}[];
  tokens?: (Omit<
    NonNullable<SolanaTransactionBalances['tokens']>[number],
    'before' | 'after'
  > & {
    before?: {amount: string; owner?: string};
    after?: {amount: string; owner?: string};
  })[];
};

type SavedTransaction = {
  chainId: string;
  address: string;
  signedTransaction: string;
  timestamp: number;
  status: SolanaTransactionHistoryItem['status'];
  confirmation?: Omit<Confirmation, 'fee' | 'balances'> & {
    fee?: string;
    balances?: SavedBalances;
  };
};

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    submittedSolanaTransactions: SavedTransaction[];
  }
}

export class SolanaTransactionHistoryService {
  private records = observable.map<string, SolanaTransactionHistoryDetail>([], {
    deep: false,
  });
  private writing = Promise.resolve();
  private revision = 0;
  private savedRevision = 0;

  private constructor(
    private storage: StorageService,
    saved: SavedTransaction[],
  ) {
    runInAction(() => {
      for (const {confirmation, ...record} of saved) {
        const detail = createDetail(
          record.chainId,
          record.address,
          record.signedTransaction,
          record.timestamp,
          record.status,
          confirmation && {
            ...confirmation,
            fee:
              confirmation.fee === undefined
                ? undefined
                : BigInt(confirmation.fee),
            balances:
              confirmation.balances &&
              deserializeBalances(confirmation.balances),
          },
        );
        const {chainId, address, id} = detail.transaction;
        this.records.set(transactionKey(chainId, id, address), detail);
      }
    });
  }

  get pendingTransactions(): readonly SolanaTransactionHistoryItem[] {
    return [...this.records.values()]
      .map(({transaction}) => transaction)
      .filter(
        transaction =>
          transaction.status === 'pending' ||
          (transaction.status === 'signed' && !!transaction.signature),
      );
  }

  list(address: string): readonly SolanaTransactionHistoryItem[] {
    return [...this.records.values()]
      .map(({transaction}) => transaction)
      .filter(transaction => transaction.address === address)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  get(
    address: string,
    chainId: string,
    id: string,
  ): SolanaTransactionHistoryDetail | undefined {
    return this.records.get(transactionKey(chainId, id, address));
  }

  getBySignature(
    chainId: string,
    signature: string,
  ): SolanaTransactionHistoryDetail | undefined {
    return [...this.records.values()].find(
      ({transaction}) =>
        transaction.chainId === chainId && transaction.signature === signature,
    );
  }

  getConfirmation(
    chainId: string,
    signature: string,
  ): SolanaTransactionConfirmation | undefined {
    const detail = this.getBySignature(chainId, signature);
    if (!detail) return undefined;
    const {status} = detail.transaction;
    return status === 'confirmed' || status === 'failed'
      ? detail.confirmation
      : {status};
  }

  rememberSigned(
    chainId: string,
    address: string,
    signedTransaction: string,
    timestamp = Date.now(),
  ): Promise<void> {
    return this.remember(chainId, address, signedTransaction, timestamp, false);
  }

  rememberSubmitted(
    chainId: string,
    address: string,
    signedTransaction: string,
    timestamp = Date.now(),
  ): Promise<void> {
    getSignedSolanaTransactionSignature(signedTransaction);
    return this.remember(chainId, address, signedTransaction, timestamp, true);
  }

  private remember(
    chainId: string,
    address: string,
    signedTransaction: string,
    timestamp: number,
    submitted: boolean,
  ): Promise<void> {
    const detail = createDetail(
      chainId,
      address,
      signedTransaction,
      timestamp,
      'signed',
    );
    const {id} = detail.transaction;
    const related = [...this.records.values()].filter(
      ({transaction}) =>
        transaction.chainId === chainId && transaction.id === id,
    );
    for (const previous of related) {
      signedTransaction = mergeSignatures(
        signedTransaction,
        previous.signedTransaction,
      );
    }
    const current =
      related.find(record => record.confirmation) ??
      related.find(({transaction}) => transaction.status === 'pending') ??
      related.find(({transaction}) => transaction.status === 'not-found') ??
      related[0];
    const status =
      current?.confirmation?.status ??
      (submitted ? 'pending' : (current?.transaction.status ?? 'signed'));
    const next = createDetail(
      chainId,
      address,
      signedTransaction,
      timestamp,
      status,
      current?.confirmation,
    );
    if (!related.some(({transaction}) => transaction.address === address)) {
      related.push(detail);
    }
    runInAction(() => {
      for (const previous of related) {
        const transaction = {
          ...next.transaction,
          address: previous.transaction.address,
          timestamp: previous.transaction.timestamp,
        };
        const key = transactionKey(chainId, id, transaction.address);
        if (
          this.records.has(key) &&
          previous.signedTransaction === next.signedTransaction &&
          previous.transaction.status === status &&
          previous.confirmation === next.confirmation
        )
          continue;
        this.records.set(key, {...next, transaction});
        this.revision++;
      }
    });
    return this.save();
  }

  rememberConfirmation(
    chainId: string,
    signature: string,
    confirmation: SolanaTransactionConfirmation,
  ): Promise<void> {
    runInAction(() => {
      for (const [key, detail] of this.records) {
        const {transaction, confirmation: previous} = detail;
        if (
          transaction.chainId !== chainId ||
          transaction.signature !== signature
        ) {
          continue;
        }
        const terminal =
          confirmation.status === 'confirmed' ||
          confirmation.status === 'failed';
        if (
          !terminal &&
          (previous ||
            confirmation.error !== undefined ||
            (transaction.status === 'pending' &&
              confirmation.status !== 'pending') ||
            (transaction.status === 'not-found' &&
              confirmation.status === 'signed'))
        )
          continue;
        if (previous && previous.status !== confirmation.status) continue;
        const normalized: Confirmation | undefined = terminal
          ? {
              status: confirmation.status,
              slot: confirmation.slot,
              fee: confirmation.fee ?? previous?.fee,
              balances:
                confirmation.balances || previous?.balances
                  ? {
                      native:
                        confirmation.balances?.native ??
                        previous?.balances?.native,
                      tokens:
                        confirmation.balances?.tokens ??
                        previous?.balances?.tokens,
                    }
                  : undefined,
              executionError:
                confirmation.executionError ?? previous?.executionError,
            }
          : undefined;
        if (
          transaction.status === confirmation.status &&
          previous?.slot === normalized?.slot &&
          previous?.fee === normalized?.fee &&
          previous?.executionError === normalized?.executionError &&
          JSON.stringify(
            previous?.balances && serializeBalances(previous.balances),
          ) ===
            JSON.stringify(
              normalized?.balances && serializeBalances(normalized.balances),
            )
        ) {
          continue;
        }
        this.records.set(key, {
          ...detail,
          transaction: {...transaction, status: confirmation.status},
          confirmation: normalized,
        });
        this.revision++;
      }
    });
    return this.save();
  }

  private save(): Promise<void> {
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        if (this.savedRevision === this.revision) return;
        const revision = this.revision;
        const saved = [...this.records.values()].map(
          ({signedTransaction, transaction, confirmation}) => ({
            chainId: transaction.chainId,
            address: transaction.address,
            signedTransaction,
            timestamp: transaction.timestamp,
            status: transaction.status,
            confirmation: confirmation && {
              ...confirmation,
              fee: confirmation.fee?.toString(),
              balances:
                confirmation.balances &&
                serializeBalances(confirmation.balances),
            },
          }),
        );
        await this.storage.set('submittedSolanaTransactions', saved);
        this.savedRevision = revision;
      });
    return this.writing;
  }

  static async create(
    storage: StorageService,
  ): Promise<SolanaTransactionHistoryService> {
    const saved = await storage.get('submittedSolanaTransactions');
    return new SolanaTransactionHistoryService(storage, saved ?? []);
  }
}

function serializeBalances(balances: SolanaTransactionBalances): SavedBalances {
  return {
    native: balances.native?.map(balance => ({
      ...balance,
      before: balance.before.toString(),
      after: balance.after.toString(),
    })),
    tokens: balances.tokens?.map(balance => ({
      ...balance,
      before: balance.before && {
        ...balance.before,
        amount: balance.before.amount.toString(),
      },
      after: balance.after && {
        ...balance.after,
        amount: balance.after.amount.toString(),
      },
    })),
  };
}

function deserializeBalances(
  balances: SavedBalances,
): SolanaTransactionBalances {
  return {
    native: balances.native?.map(balance => ({
      ...balance,
      before: BigInt(balance.before),
      after: BigInt(balance.after),
    })),
    tokens: balances.tokens?.map(balance => ({
      ...balance,
      before: balance.before && {
        ...balance.before,
        amount: BigInt(balance.before.amount),
      },
      after: balance.after && {
        ...balance.after,
        amount: BigInt(balance.after.amount),
      },
    })),
  };
}

function createDetail(
  chainId: string,
  address: string,
  signedTransaction: string,
  timestamp: number,
  status: SolanaTransactionHistoryItem['status'],
  confirmation?: Confirmation,
): SolanaTransactionHistoryDetail {
  const transaction = parseSolanaTransaction(signedTransaction);
  const signerIndex = transaction.signerAddresses.indexOf(address);
  if (
    signerIndex === -1 ||
    !transaction.signatures[signerIndex].some(byte => byte)
  ) {
    throw new Error('The account did not sign this Solana transaction.');
  }

  return {
    signedTransaction,
    transaction: {
      id: base58.encode(getBytes(sha256(transaction.messageBytes))),
      chainId,
      address,
      signature: transaction.signatures[0].some(byte => byte)
        ? base58.encode(transaction.signatures[0])
        : undefined,
      timestamp,
      status,
    },
    confirmation,
  };
}

function transactionKey(chainId: string, id: string, address: string): string {
  return `${chainId}:${id}:${address}`;
}

function mergeSignatures(incoming: string, existing: string): string {
  if (incoming === existing) return incoming;
  const next = parseSolanaTransaction(incoming);
  const previous = parseSolanaTransaction(existing);
  const bytes = next.bytes.slice();
  for (const [index, signature] of previous.signatures.entries()) {
    if (!signature.some(byte => byte)) continue;
    const replacement = next.signatures[index];
    if (
      replacement.some(byte => byte) &&
      !signature.every((byte, position) => byte === replacement[position])
    ) {
      throw new Error('This Solana transaction has conflicting signatures.');
    }
    bytes.set(
      signature,
      next.messageOffset - (next.signatures.length - index) * 64,
    );
  }
  return base64.encode(bytes);
}
