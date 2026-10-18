const DEFAULT_API_URL = 'https://blockstream.info/api';
const MAX_MONEY = BigInt(2_100_000_000_000_000);

export type BitcoinTransactionStatus =
  | {confirmed: false}
  | {
      confirmed: true;
      blockHeight: number;
      blockHash: string;
      blockTime: number;
    };

export type BitcoinUtxo = {
  txid: string;
  vout: number;
  value: bigint;
  status: BitcoinTransactionStatus;
};

export type BitcoinOutput = {
  address?: string;
  script: string;
  value: bigint;
};

export type BitcoinTransaction = {
  txid: string;
  inputs: {coinbase: boolean; previousOutput?: BitcoinOutput}[];
  outputs: BitcoinOutput[];
  fee: bigint;
  status: BitcoinTransactionStatus;
};

export type BitcoinAddressSummary = {
  address: string;
  confirmedBalance: bigint;
  pendingBalance: bigint;
  confirmedTransactionCount: number;
  pendingTransactionCount: number;
};

export type BitcoinFeeRates = {
  economy: number;
  normal: number;
  fast: number;
};

export class BitcoinBroadcastError extends Error {
  constructor(
    message: string,
    readonly outcome: 'rejected' | 'unknown',
    readonly txid: string,
  ) {
    super(message);
    this.name = 'BitcoinBroadcastError';
  }
}

class BitcoinHttpError extends Error {
  constructor(readonly status: number) {
    super(`Bitcoin service returned HTTP ${status}.`);
  }
}

/** Mainnet Esplora API. All monetary values leave this boundary as exact satoshis. */
export class BitcoinApi {
  constructor(
    private baseUrl = DEFAULT_API_URL,
    private fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private timeoutMs = 15_000,
  ) {}

  async getAddress(
    address: string,
    signal?: AbortSignal,
  ): Promise<BitcoinAddressSummary> {
    const data = record(
      await this.json(`/address/${addressPath(address)}`, signal),
    );
    if (data.address !== address) invalidResponse();
    const confirmed = record(data.chain_stats);
    const pending = record(data.mempool_stats);
    const confirmedBalance =
      amount(confirmed.funded_txo_sum) - amount(confirmed.spent_txo_sum);
    const pendingBalance =
      amount(pending.funded_txo_sum) - amount(pending.spent_txo_sum);
    if (
      confirmedBalance < BigInt(0) ||
      confirmedBalance > MAX_MONEY ||
      confirmedBalance + pendingBalance < BigInt(0) ||
      confirmedBalance + pendingBalance > MAX_MONEY
    )
      invalidResponse();
    return {
      address,
      confirmedBalance,
      pendingBalance,
      confirmedTransactionCount: integer(confirmed.tx_count),
      pendingTransactionCount: integer(pending.tx_count),
    };
  }

  async getUtxos(
    address: string,
    signal?: AbortSignal,
  ): Promise<BitcoinUtxo[]> {
    const values = array(
      await this.json(`/address/${addressPath(address)}/utxo`, signal),
    );
    const seen = new Set<string>();
    return values.map(value => {
      const data = record(value);
      const txid = hash(data.txid);
      const vout = integer(data.vout, 0xffff_ffff);
      const key = `${txid}:${vout}`;
      if (seen.has(key)) invalidResponse();
      seen.add(key);
      return {
        txid,
        vout,
        value: amount(data.value, MAX_MONEY),
        status: status(data.status),
      };
    });
  }

  async getTransactions(
    address: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<BitcoinTransaction[]> {
    const path = `/address/${addressPath(address)}/txs${cursor ? `/chain/${hash(cursor)}` : ''}`;
    const transactions = array(await this.json(path, signal)).map(transaction);
    if (
      new Set(transactions.map(item => item.txid)).size !==
        transactions.length ||
      transactions.length > (cursor ? 25 : 75) ||
      (cursor && transactions.some(item => !item.status.confirmed))
    )
      invalidResponse();
    return transactions;
  }

  async getTransaction(
    txid: string,
    signal?: AbortSignal,
  ): Promise<BitcoinTransaction> {
    const value = transaction(await this.json(`/tx/${hash(txid)}`, signal));
    if (value.txid !== txid) invalidResponse();
    return value;
  }

  async getTipHeight(signal?: AbortSignal): Promise<number> {
    const value = await this.request('/blocks/tip/height', {}, signal);
    if (!/^\d+$/.test(value)) invalidResponse();
    return integer(Number(value));
  }

  async getFeeRates(signal?: AbortSignal): Promise<BitcoinFeeRates> {
    const estimates = record(await this.json('/fee-estimates', signal));
    const rate = (target: string): number => {
      const value = estimates[target];
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(Math.ceil(value)) ||
        value <= 0
      )
        invalidResponse();
      return Math.max(1, Math.ceil(value));
    };
    const economy = rate('6');
    const normal = Math.max(economy, rate('3'));
    return {economy, normal, fast: Math.max(normal, rate('1'))};
  }

  async getTransactionHex(txid: string, signal?: AbortSignal): Promise<string> {
    return hex(await this.request(`/tx/${hash(txid)}/hex`, {}, signal), false);
  }

  async getPreviousTransactions(
    utxos: readonly Pick<BitcoinUtxo, 'txid'>[],
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    const txids = [...new Set(utxos.map(utxo => utxo.txid))];
    const values = await mapLimited(txids, txid =>
      this.getTransactionHex(txid, signal),
    );
    return Object.fromEntries(
      txids.map((txid, index) => [txid, values[index]]),
    );
  }

  async broadcastTransaction(
    rawHex: string,
    expectedTxid: string,
    signal?: AbortSignal,
  ): Promise<string> {
    hex(rawHex, false);
    hash(expectedTxid);
    try {
      const txid = hash(
        await this.request(
          '/tx',
          {
            method: 'POST',
            headers: {'Content-Type': 'text/plain'},
            body: rawHex,
          },
          signal,
        ),
      );
      if (txid !== expectedTxid) invalidResponse();
      return txid;
    } catch (error) {
      // A lost response does not prove the transaction was rejected. Keep its
      // signed bytes and txid so the caller can check or rebroadcast the same tx.
      if (error instanceof BitcoinHttpError && error.status === 400) {
        // Re-broadcasting an accepted transaction can also return HTTP 400.
        // A subsequent 404 can be index lag, so it cannot release the inputs.
        try {
          await this.getTransaction(expectedTxid, signal);
          return expectedTxid;
        } catch {
          // Keep the original transaction reserved until acceptance is known.
        }
      }
      throw new BitcoinBroadcastError(
        'Broadcast could not be confirmed. Check the transaction status before sending again.',
        'unknown',
        expectedTxid,
      );
    }
  }

  private async json(path: string, signal?: AbortSignal): Promise<unknown> {
    try {
      return JSON.parse(await this.request(path, {}, signal)) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) invalidResponse();
      throw error;
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, {once: true});
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetcher(
        `${this.baseUrl.replace(/\/$/, '')}${path}`,
        {
          ...init,
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new BitcoinHttpError(response.status);
      return (await response.text()).trim();
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (timedOut)
        throw new Error('The Bitcoin service timed out. Please try again.', {
          cause: error,
        });
      if (error instanceof BitcoinHttpError) throw error;
      throw new Error(
        'Could not reach the Bitcoin service. Check your connection and try again.',
        {cause: error},
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

function invalidResponse(): never {
  throw new Error(
    'The Bitcoin service returned invalid data. Please try again.',
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalidResponse();
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalidResponse();
  return value;
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  )
    invalidResponse();
  return value;
}

function amount(value: unknown, maximum?: bigint): bigint {
  const result = BigInt(integer(value));
  if (maximum !== undefined && result > maximum) invalidResponse();
  return result;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[\da-f]{64}$/.test(value))
    invalidResponse();
  return value;
}

function hex(value: unknown, empty = true): string {
  if (
    typeof value !== 'string' ||
    !/^(?:[\da-f]{2})*$/.test(value) ||
    (!empty && !value) ||
    value.length > 8_000_000
  )
    invalidResponse();
  return value;
}

function addressPath(address: string): string {
  if (!/^[a-zA-Z\d]{14,90}$/.test(address))
    throw new Error('Invalid Bitcoin address.');
  return encodeURIComponent(address);
}

function status(value: unknown): BitcoinTransactionStatus {
  const data = record(value);
  if (data.confirmed === false) return {confirmed: false};
  if (data.confirmed !== true) invalidResponse();
  return {
    confirmed: true,
    blockHeight: integer(data.block_height),
    blockHash: hash(data.block_hash),
    blockTime: integer(data.block_time),
  };
}

function output(value: unknown): BitcoinOutput {
  const data = record(value);
  if (
    data.scriptpubkey_address !== undefined &&
    typeof data.scriptpubkey_address !== 'string'
  )
    invalidResponse();
  return {
    address: data.scriptpubkey_address as string | undefined,
    script: hex(data.scriptpubkey),
    value: amount(data.value, MAX_MONEY),
  };
}

function transaction(value: unknown): BitcoinTransaction {
  const data = record(value);
  const inputs = array(data.vin).map(value => {
    const input = record(value);
    if (typeof input.is_coinbase !== 'boolean') invalidResponse();
    return {
      coinbase: input.is_coinbase,
      previousOutput: input.is_coinbase ? undefined : output(input.prevout),
    };
  });
  const outputs = array(data.vout).map(output);
  if (!inputs.length || !outputs.length) invalidResponse();
  return {
    txid: hash(data.txid),
    inputs,
    outputs,
    fee: amount(data.fee, MAX_MONEY),
    status: status(data.status),
  };
}

export async function mapLimited<T, R>(
  values: readonly T[],
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({length: Math.min(4, values.length)}, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await operation(values[index]);
      }
    }),
  );
  return results;
}
