import {type Provider, Transaction, isError} from 'ethers';
import {observable, runInAction} from 'mobx';

import {
  type EvmTransactionReplacementKind,
  assertEvmTransactionReplacement,
} from '../@lib/evm-transaction-replacement.js';
import type {
  EvmTransaction,
  EvmTransactionReceipt,
} from '../@lib/evm-transaction.js';

import type {StorageService} from './storage-service.js';

export type TransactionHistoryItem = EvmTransaction & {
  timestamp: number;
  status: 'pending' | 'confirmed' | 'failed' | 'replaced';
};

export type TransactionHistoryDetail = {
  signedTransaction: string;
  transaction: TransactionHistoryItem;
  receipt?: EvmTransactionReceipt;
  replacementHash?: string;
  submission?: TransactionReplacementSubmission;
};

type TransactionReplacementSubmission = {
  kind: EvmTransactionReplacementKind;
  signedTransaction: string;
};

type TransactionRecord = {
  nonce: number;
  detail: TransactionHistoryDetail;
};

type SavedTransaction = {
  signedTransaction: string;
  timestamp: number;
  receipt?: Omit<EvmTransactionReceipt, 'fee'> & {fee: string};
  submission?: TransactionReplacementSubmission;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    submittedTransactions: SavedTransaction[];
  }
}

export class TransactionHistoryService {
  private records = observable.map<string, TransactionRecord>([], {
    deep: false,
  });
  private writing = Promise.resolve();
  private replacements = new Map<
    string,
    {signedTransaction: string; response: Promise<TransactionHistoryDetail>}
  >();

  private constructor(
    private storage: StorageService,
    saved: SavedTransaction[],
  ) {
    runInAction(() => {
      for (const {signedTransaction, timestamp, receipt, submission} of saved) {
        const record = createRecord(
          signedTransaction,
          timestamp,
          receipt ? {...receipt, fee: BigInt(receipt.fee)} : undefined,
          submission,
        );
        const {chainId, hash} = record.detail.transaction;
        this.records.set(transactionKey(`eip155:${chainId}`, hash), record);
      }
      this.reconcile();
    });
  }

  get addresses(): readonly string[] {
    return [
      ...new Set(
        [...this.records.values()].map(({detail}) => detail.transaction.from),
      ),
    ];
  }

  get pendingTransactions(): readonly TransactionHistoryItem[] {
    return [...this.records.values()]
      .map(({detail}) => detail.transaction)
      .filter(transaction => transaction.status === 'pending');
  }

  list(address: string): readonly TransactionHistoryItem[] {
    return [...this.records.values()]
      .map(({detail}) => detail.transaction)
      .filter(transaction => sameAddress(transaction.from, address))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  get(
    address: string,
    chainId: string,
    hash: string,
  ): TransactionHistoryDetail | undefined {
    const detail = this.records.get(transactionKey(chainId, hash))?.detail;
    return detail && sameAddress(detail.transaction.from, address)
      ? detail
      : undefined;
  }

  getCompetingHashes(chainId: string, hash: string): string[] {
    return this.getCompetingTransactions(chainId, hash).map(
      raw => Transaction.from(raw).hash!,
    );
  }

  getCompetingTransactions(chainId: string, hash: string): string[] {
    const record = this.records.get(transactionKey(chainId, hash));
    if (!record) return [];

    const transactions = new Set<string>();
    for (const other of this.records.values()) {
      if (!sameNonce(record, other)) continue;
      const {signedTransaction, submission} = other.detail;
      if (other !== record) transactions.add(signedTransaction);
      if (submission) transactions.add(submission.signedTransaction);
    }
    transactions.delete(record.detail.signedTransaction);
    return [...transactions];
  }

  rememberSubmitted(signedTransaction: string): Promise<void> {
    const record = createRecord(signedTransaction, Date.now());
    const {chainId, hash} = record.detail.transaction;
    const key = transactionKey(`eip155:${chainId}`, hash);

    if (!this.records.has(key)) {
      runInAction(() => {
        this.records.set(key, record);
        this.reconcile();
      });
    }
    return this.save();
  }

  rememberReceipt(
    chainId: bigint,
    hash: string,
    receipt: EvmTransactionReceipt,
  ): Promise<void> {
    const key = transactionKey(`eip155:${chainId}`, hash);
    let record = this.records.get(key);
    if (!record) {
      const source = [...this.records.values()].find(
        ({detail}) =>
          detail.transaction.chainId === chainId &&
          detail.submission &&
          Transaction.from(
            detail.submission.signedTransaction,
          ).hash!.toLowerCase() === hash.toLowerCase(),
      );
      if (source)
        record = createRecord(
          source.detail.submission!.signedTransaction,
          Date.now(),
        );
    }
    if (!record) return Promise.resolve();
    if (receipt.hash.toLowerCase() !== hash.toLowerCase()) {
      throw new Error('The RPC returned a different transaction hash.');
    }
    if (receipt.status !== 0 && receipt.status !== 1) {
      throw new Error('The receipt does not include an execution status.');
    }

    const normalized: EvmTransactionReceipt = {
      hash: receipt.hash,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      fee: receipt.fee,
      logs: receipt.logs.map(({address, topics, data, index}) => ({
        address,
        topics: [...topics],
        data,
        index,
      })),
    };

    const current = record;
    runInAction(() => {
      this.records.set(key, {
        ...current,
        detail: {
          ...current.detail,
          transaction: {
            ...current.detail.transaction,
            status: receiptStatus(normalized),
          },
          receipt: normalized,
        },
      });
      this.reconcile();
    });
    return this.save();
  }

  submitReplacement(
    chainId: string,
    hash: string,
    kind: EvmTransactionReplacementKind,
    unsignedTransaction: string,
    signature: string,
    provider: Provider,
  ): Promise<TransactionHistoryDetail> {
    const key = transactionKey(chainId, hash);
    const record = this.records.get(key);
    if (!record) throw new Error('Transaction not found.');

    const original = Transaction.from(record.detail.signedTransaction);
    const transaction = Transaction.from(unsignedTransaction);
    transaction.signature = signature;
    const signedTransaction = transaction.serialized;
    const retry =
      record.detail.submission?.signedTransaction === signedTransaction;
    const competing = retry
      ? []
      : this.getCompetingTransactions(chainId, hash)
          .map(raw => Transaction.from(raw))
          .filter(other => other.hash !== transaction.hash);
    assertEvmTransactionReplacement(original, transaction, kind, competing);
    if (transaction.from !== original.from) {
      throw new Error('The signature does not match the original account.');
    }

    const pending = this.replacements.get(key);
    if (pending) {
      if (pending.signedTransaction !== signedTransaction) {
        throw new Error('Retry the replacement that was already submitted.');
      }
      return pending.response;
    }

    const response = Promise.resolve()
      .then(() =>
        this.sendReplacement(key, kind, transaction, original, provider),
      )
      .finally(() => this.replacements.delete(key));
    this.replacements.set(key, {signedTransaction, response});
    return response;
  }

  private async sendReplacement(
    key: string,
    kind: EvmTransactionReplacementKind,
    transaction: Transaction,
    original: Transaction,
    provider: Provider,
  ): Promise<TransactionHistoryDetail> {
    const record = this.records.get(key)!;
    const signedTransaction = transaction.serialized;
    const hash = transaction.hash!;
    const {submission} = record.detail;
    if (
      submission &&
      (submission.kind !== kind ||
        submission.signedTransaction !== signedTransaction)
    ) {
      throw new Error('Retry the replacement that was already submitted.');
    }
    if (record.detail.transaction.status !== 'pending') {
      throw new Error('This transaction is no longer pending.');
    }

    const network = await provider.getNetwork();
    if (network.chainId !== transaction.chainId) {
      throw new Error('The RPC uses a different network.');
    }
    if (this.records.get(key)!.detail.transaction.status !== 'pending') {
      throw new Error('This transaction is no longer pending.');
    }

    // Save the exact bytes before the RPC can accept them, including retries.
    this.setSubmission(key, {kind, signedTransaction});
    await this.save();

    const isAccepted = async (): Promise<boolean> => {
      const known = await provider.getTransaction(hash);
      if (known && known.hash.toLowerCase() !== hash.toLowerCase()) {
        throw new Error('The RPC returned a different transaction hash.');
      }
      return known !== null;
    };

    if (!(await isAccepted())) {
      const receipt = await provider.getTransactionReceipt(original.hash!);
      if (receipt) {
        await this.rememberReceipt(original.chainId, original.hash!, receipt);
        throw new Error('This transaction is no longer pending.');
      }
      const nonce = await provider.getTransactionCount(
        original.from!,
        'latest',
      );
      if (nonce > original.nonce) {
        throw new Error(
          'This nonce has already been used. Refresh the transaction status.',
        );
      }
      if (this.records.get(key)!.detail.transaction.status !== 'pending') {
        throw new Error('This transaction is no longer pending.');
      }

      try {
        const result = await provider.broadcastTransaction(signedTransaction);
        if (result.hash.toLowerCase() !== hash.toLowerCase()) {
          throw new Error('The RPC returned a different transaction hash.');
        }
      } catch (error) {
        if (!(await isAccepted().catch(() => false))) {
          if (
            isError(error, 'REPLACEMENT_UNDERPRICED') ||
            isError(error, 'INSUFFICIENT_FUNDS')
          ) {
            this.setSubmission(key, undefined);
            await this.save();
          }
          throw error;
        }
      }
    }

    await this.rememberSubmitted(signedTransaction);
    this.setSubmission(key, undefined);
    await this.save();
    return this.records.get(
      transactionKey(`eip155:${transaction.chainId}`, hash),
    )!.detail;
  }

  private setSubmission(
    key: string,
    submission: TransactionReplacementSubmission | undefined,
  ): void {
    const record = this.records.get(key)!;
    runInAction(() =>
      this.records.set(key, {
        ...record,
        detail: {...record.detail, submission},
      }),
    );
  }

  private reconcile(): void {
    const records = [...this.records.entries()];
    for (const [key, record] of records) {
      const {detail} = record;
      const winner = detail.receipt
        ? undefined
        : records.find(
            ([, other]) => other.detail.receipt && sameNonce(record, other),
          )?.[1];
      const replacementHash = winner?.detail.transaction.hash;
      const status = replacementHash
        ? 'replaced'
        : receiptStatus(detail.receipt);
      const submission = status === 'pending' ? detail.submission : undefined;
      if (
        status !== detail.transaction.status ||
        replacementHash !== detail.replacementHash ||
        submission !== detail.submission
      ) {
        this.records.set(key, {
          ...record,
          detail: {
            ...detail,
            transaction: {...detail.transaction, status},
            replacementHash,
            submission,
          },
        });
      }
    }
  }

  private save(): Promise<void> {
    // Repeated submissions retry failed writes without changing their timestamp.
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        const saved = [...this.records.values()].map(
          ({
            detail: {signedTransaction, transaction, receipt, submission},
          }) => ({
            signedTransaction,
            timestamp: transaction.timestamp,
            receipt: receipt
              ? {...receipt, fee: receipt.fee.toString()}
              : undefined,
            submission,
          }),
        );
        await this.storage.set('submittedTransactions', saved);
      });
    return this.writing;
  }

  static async create(
    storage: StorageService,
  ): Promise<TransactionHistoryService> {
    const saved = await storage.get('submittedTransactions');
    return new TransactionHistoryService(storage, saved ?? []);
  }
}

function createRecord(
  signedTransaction: string,
  timestamp: number,
  receipt?: EvmTransactionReceipt,
  submission?: TransactionReplacementSubmission,
): TransactionRecord {
  const transaction = Transaction.from(signedTransaction);
  if (!transaction.isSigned()) {
    throw new Error('A submitted transaction must be signed.');
  }

  return {
    nonce: transaction.nonce,
    detail: {
      signedTransaction,
      transaction: {
        chainId: transaction.chainId,
        hash: transaction.hash!,
        from: transaction.from,
        to: transaction.to,
        value: transaction.value,
        timestamp,
        status: receiptStatus(receipt),
      },
      receipt,
      submission,
    },
  };
}

function sameNonce(a: TransactionRecord, b: TransactionRecord): boolean {
  const first = a.detail.transaction;
  const second = b.detail.transaction;
  return (
    first.chainId === second.chainId &&
    sameAddress(first.from, second.from) &&
    a.nonce === b.nonce
  );
}

function receiptStatus(
  receipt: EvmTransactionReceipt | undefined,
): TransactionHistoryItem['status'] {
  return receipt?.status === 1
    ? 'confirmed'
    : receipt?.status === 0
      ? 'failed'
      : 'pending';
}

function transactionKey(chainId: string, hash: string): string {
  return `${chainId}:${hash.toLowerCase()}`;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
