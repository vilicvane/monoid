import {observable, runInAction} from 'mobx';

import {
  BitcoinApi,
  BitcoinBroadcastError,
  type BitcoinTransaction,
  type BitcoinTransactionStatus,
  type BitcoinUtxo,
  mapLimited,
} from '../@lib/bitcoin-api.js';

import type {StorageService} from './storage-service.js';

export type BitcoinWalletTransaction = {
  txid: string;
  netSats: bigint;
  receivedSats: bigint;
  spentSats: bigint;
  fee: bigint;
  status: BitcoinTransactionStatus;
  confirmations: number;
};

export type BitcoinWalletSnapshot = {
  address: string;
  confirmedBalance: bigint;
  pendingBalance: bigint;
  spendableBalance: bigint;
  utxos: BitcoinUtxo[];
  transactions: BitcoinWalletTransaction[];
  tipHeight: number;
  updatedAt: number;
  hasMore: boolean;
  pendingHistoryTruncated: boolean;
};

export type BitcoinWalletState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  snapshot?: BitcoinWalletSnapshot;
  error?: string;
  loadingMore: boolean;
  historyError?: string;
};

export type BitcoinSubmission = {
  address: string;
  txid: string;
  hex: string;
  inputOutpoints: string[];
  payment?: {recipient: string; amountSats: string; feeSats: string};
  createdAt: number;
  status: 'signed' | 'submitted' | 'unknown' | 'rejected' | 'confirmed';
  error?: string;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    bitcoinSubmissions: BitcoinSubmission[];
  }
}

const EMPTY_STATE: BitcoinWalletState = {status: 'idle', loadingMore: false};

export class BitcoinWalletService {
  private states = observable.map<string, BitcoinWalletState>([], {
    deep: false,
  });
  private submissions = observable.map<string, BitcoinSubmission>([], {
    deep: false,
  });
  private requests = new Map<string, AbortController>();
  private historyRequests = new Map<string, AbortController>();
  private writing = Promise.resolve();

  constructor(
    readonly api = new BitcoinApi(),
    private storage?: Pick<StorageService, 'set'>,
    saved: BitcoinSubmission[] = [],
  ) {
    runInAction(() => {
      for (const submission of saved)
        this.submissions.set(submission.txid, submission);
    });
  }

  get(address: string): BitcoinWalletState {
    const state = this.states.get(address) ?? EMPTY_STATE;
    if (!state.snapshot) return state;
    const reserved = this.reservedOutpoints(address);
    if (!reserved.size) return state;
    const utxos = state.snapshot.utxos.filter(
      utxo => !reserved.has(outpoint(utxo)),
    );
    return {
      ...state,
      snapshot: {
        ...state.snapshot,
        utxos,
        spendableBalance: utxos.reduce(
          (sum, utxo) => sum + utxo.value,
          BigInt(0),
        ),
      },
    };
  }

  getSubmissions(address: string): BitcoinSubmission[] {
    return [...this.submissions.values()]
      .filter(submission => submission.address === address)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  reservedOutpoints(address: string): ReadonlySet<string> {
    return new Set(
      this.getSubmissions(address)
        .filter(submission => submission.status !== 'rejected')
        .flatMap(submission => submission.inputOutpoints),
    );
  }

  async refresh(
    address: string,
    {preserveHistory = false}: {preserveHistory?: boolean} = {},
  ): Promise<void> {
    this.cancel(address);
    const previousSnapshot = this.states.get(address)?.snapshot;
    const controller = new AbortController();
    this.requests.set(address, controller);
    this.update(address, {
      ...this.states.get(address),
      status: 'loading',
      error: undefined,
      loadingMore: false,
      historyError: undefined,
    });
    try {
      const [summary, allUtxos, transactions, tipHeight] = await Promise.all([
        this.api.getAddress(address, controller.signal),
        this.api.getUtxos(address, controller.signal),
        this.api.getTransactions(address, undefined, controller.signal),
        this.api.getTipHeight(controller.signal),
      ]);
      const confirmed = allUtxos.filter(utxo => utxo.status.confirmed);
      const recentTxids = [
        ...new Set(
          confirmed
            .filter(
              utxo =>
                utxo.status.confirmed &&
                tipHeight - utxo.status.blockHeight + 1 < 100,
            )
            .map(utxo => utxo.txid),
        ),
      ];
      const recent = await mapLimited(recentTxids, txid =>
        this.api.getTransaction(txid, controller.signal),
      );
      const immature = new Set(
        recent
          .filter(tx => tx.inputs.some(input => input.coinbase))
          .map(tx => tx.txid),
      );
      const utxos = confirmed.filter(utxo => !immature.has(utxo.txid));
      if (controller.signal.aborted) return;
      const confirmedTransactions = transactions.filter(
        tx => tx.status.confirmed,
      );
      let snapshot: BitcoinWalletSnapshot = {
        address,
        confirmedBalance: summary.confirmedBalance,
        pendingBalance: summary.pendingBalance,
        spendableBalance: utxos.reduce(
          (sum, utxo) => sum + utxo.value,
          BigInt(0),
        ),
        utxos,
        transactions: transactions.map(tx =>
          walletTransaction(tx, address, tipHeight),
        ),
        tipHeight,
        updatedAt: Date.now(),
        hasMore: confirmedTransactions.length === 25,
        pendingHistoryTruncated:
          summary.pendingTransactionCount >
          transactions.length - confirmedTransactions.length,
      };
      if (preserveHistory && previousSnapshot) {
        snapshot = preserveConfirmedHistory(previousSnapshot, snapshot);
      }
      this.update(address, {status: 'ready', snapshot, loadingMore: false});
      let changed = false;
      runInAction(() => {
        for (const tx of transactions) {
          const saved = this.submissions.get(tx.txid);
          if (!saved || saved.address !== address) continue;
          const status = tx.status.confirmed ? 'confirmed' : 'submitted';
          if (saved.status === status) continue;
          this.submissions.set(tx.txid, {...saved, status, error: undefined});
          changed = true;
        }
      });
      if (changed) await this.save();
    } catch (error) {
      if (!controller.signal.aborted) {
        this.update(address, {
          ...this.states.get(address),
          status: 'error',
          error: errorMessage(error),
          loadingMore: false,
        });
        controller.abort();
      }
    } finally {
      if (this.requests.get(address) === controller)
        this.requests.delete(address);
    }
  }

  async loadMore(address: string): Promise<void> {
    const current = this.states.get(address);
    if (
      !current?.snapshot?.hasMore ||
      current.loadingMore ||
      current.status === 'loading'
    )
      return;
    const cursor = current.snapshot.transactions
      .filter(tx => tx.status.confirmed)
      .at(-1)?.txid;
    if (!cursor) return;
    const controller = new AbortController();
    this.historyRequests.set(address, controller);
    this.update(address, {
      ...current,
      loadingMore: true,
      historyError: undefined,
    });
    try {
      const next = await this.api.getTransactions(
        address,
        cursor,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const previous = this.states.get(address)!;
      const snapshot = previous.snapshot!;
      const seen = new Set(snapshot.transactions.map(tx => tx.txid));
      const fresh = next.filter(tx => !seen.has(tx.txid));
      if (next.length && !fresh.length)
        throw new Error(
          'Bitcoin history did not advance. Please try again after the next update.',
        );
      this.update(address, {
        ...previous,
        loadingMore: false,
        snapshot: {
          ...snapshot,
          hasMore: next.length === 25,
          transactions: [
            ...snapshot.transactions,
            ...fresh.map(tx =>
              walletTransaction(tx, address, snapshot.tipHeight),
            ),
          ],
        },
      });
    } catch (error) {
      if (!controller.signal.aborted)
        this.update(address, {
          ...this.states.get(address)!,
          loadingMore: false,
          historyError: errorMessage(error),
        });
    } finally {
      if (this.historyRequests.get(address) === controller)
        this.historyRequests.delete(address);
    }
  }

  cancel(address: string): void {
    this.requests.get(address)?.abort();
    this.requests.delete(address);
    this.historyRequests.get(address)?.abort();
    this.historyRequests.delete(address);
    const current = this.states.get(address);
    if (current?.status === 'loading' || current?.loadingMore) {
      this.update(address, {
        ...current,
        status: current.snapshot ? 'ready' : 'idle',
        loadingMore: false,
      });
    }
  }

  async broadcast(
    address: string,
    transaction: Pick<
      BitcoinSubmission,
      'txid' | 'hex' | 'inputOutpoints' | 'payment'
    >,
    signal?: AbortSignal,
  ): Promise<string> {
    const previous = this.submissions.get(transaction.txid);
    if (
      previous &&
      (previous.address !== address || previous.hex !== transaction.hex)
    ) {
      throw new Error(
        'This Bitcoin transaction conflicts with the saved transaction.',
      );
    }
    const conflicts = [...this.submissions.values()].some(
      submission =>
        submission.txid !== transaction.txid &&
        submission.status !== 'rejected' &&
        submission.inputOutpoints.some(input =>
          transaction.inputOutpoints.includes(input),
        ),
    );
    if (conflicts) {
      throw new Error(
        'Some Bitcoin inputs already belong to another signed transaction. Refresh the wallet before sending again.',
      );
    }
    const submission: BitcoinSubmission = {
      ...transaction,
      address,
      payment: previous?.payment ?? transaction.payment,
      createdAt: previous?.createdAt ?? Date.now(),
      status: 'signed',
    };
    runInAction(() => this.submissions.set(transaction.txid, submission));
    // Persist before making a request: restarting after a lost response must
    // never release these inputs for an accidental second payment.
    await this.save();
    try {
      const txid = await this.api.broadcastTransaction(
        transaction.hex,
        transaction.txid,
        signal,
      );
      runInAction(() =>
        this.submissions.set(txid, {
          ...submission,
          status: 'submitted',
          error: undefined,
        }),
      );
      await this.save();
      return txid;
    } catch (error) {
      const definitelyRejected =
        error instanceof BitcoinBroadcastError &&
        error.outcome === 'rejected' &&
        (!previous || previous.status === 'rejected');
      runInAction(() =>
        this.submissions.set(transaction.txid, {
          ...submission,
          status: definitelyRejected ? 'rejected' : 'unknown',
          error: errorMessage(error),
        }),
      );
      await this.save();
      throw error;
    }
  }

  async updateSubmissionStatus(
    txid: string,
    status: 'submitted' | 'confirmed',
  ): Promise<void> {
    const submission = this.submissions.get(txid);
    if (!submission || submission.status === status) return;
    runInAction(() =>
      this.submissions.set(txid, {...submission, status, error: undefined}),
    );
    await this.save();
  }

  private update(address: string, state: BitcoinWalletState): void {
    runInAction(() => this.states.set(address, state));
  }

  private save(): Promise<void> {
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        await this.storage?.set('bitcoinSubmissions', [
          ...this.submissions.values(),
        ]);
      });
    return this.writing;
  }

  static async create(storage: StorageService): Promise<BitcoinWalletService> {
    return new BitcoinWalletService(
      new BitcoinApi(),
      storage,
      (await storage.get('bitcoinSubmissions')) ?? [],
    );
  }
}

function outpoint(utxo: Pick<BitcoinUtxo, 'txid' | 'vout'>): string {
  return `${utxo.txid}:${utxo.vout}`;
}

function preserveConfirmedHistory(
  previous: BitcoinWalletSnapshot,
  latest: BitcoinWalletSnapshot,
): BitcoinWalletSnapshot {
  if (latest.tipHeight < previous.tipHeight) return latest;
  const confirmed = latest.transactions.filter(tx => tx.status.confirmed);
  // A shorter page is the complete confirmed history reported by Esplora.
  if (confirmed.length !== 25) return latest;
  const loaded = previous.transactions.filter(tx => tx.status.confirmed);
  const overlapStart = confirmed.findIndex(tx => tx.txid === loaded[0]?.txid);
  if (overlapStart === -1) return latest;
  const overlap = confirmed.slice(overlapStart);
  // Keep an older tail only when the new page joins the existing history
  // without a gap, reorder or changed confirmation block.
  if (
    overlap.some((tx, index) => {
      const old = loaded[index];
      return (
        old?.txid !== tx.txid ||
        !old.status.confirmed ||
        !tx.status.confirmed ||
        old.status.blockHeight !== tx.status.blockHeight ||
        old.status.blockHash !== tx.status.blockHash
      );
    })
  )
    return latest;
  const anchor = confirmed.at(-1)!.status;
  const tail = loaded.slice(overlap.length);
  const seen = new Set(latest.transactions.map(tx => tx.txid));
  if (
    !anchor.confirmed ||
    tail.some(
      tx =>
        !tx.status.confirmed ||
        tx.status.blockHeight > anchor.blockHeight ||
        seen.has(tx.txid),
    )
  )
    return latest;
  return {
    ...latest,
    hasMore: previous.hasMore,
    transactions: [
      ...latest.transactions,
      ...tail.map(tx => ({
        ...tx,
        confirmations: tx.status.confirmed
          ? Math.max(0, latest.tipHeight - tx.status.blockHeight + 1)
          : 0,
      })),
    ],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Could not load Bitcoin wallet data. Please try again.';
}

function walletTransaction(
  tx: BitcoinTransaction,
  address: string,
  tipHeight: number,
): BitcoinWalletTransaction {
  const receivedSats = tx.outputs
    .filter(output => output.address === address)
    .reduce((sum, output) => sum + output.value, BigInt(0));
  const spentSats = tx.inputs.reduce(
    (sum, input) =>
      sum +
      (input.previousOutput?.address === address
        ? input.previousOutput.value
        : BigInt(0)),
    BigInt(0),
  );
  return {
    txid: tx.txid,
    netSats: receivedSats - spentSats,
    receivedSats,
    spentSats,
    fee: tx.fee,
    status: tx.status,
    confirmations: tx.status.confirmed
      ? Math.max(0, tipHeight - tx.status.blockHeight + 1)
      : 0,
  };
}
