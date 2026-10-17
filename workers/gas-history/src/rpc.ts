export type GasBlock = {
  number: bigint;
  timestamp: number;
  baseFeePerGas: string;
};

export class RpcBudgetExhausted extends Error {}

export class RpcRateLimited extends Error {
  constructor(readonly retryAt: number) {
    super('Gas sample RPC returned HTTP 429.');
  }
}

function retryAt(header: string | null): number {
  const now = Date.now();
  const seconds =
    header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : NaN;
  const date = header && /^[a-z]/i.test(header) ? Date.parse(header) : NaN;
  const timestamp = Number.isFinite(seconds) ? now + seconds * 1000 : date;

  return Number.isFinite(timestamp) ? Math.max(now, timestamp) : now + 5000;
}

function parseQuantity(value: unknown): bigint {
  if (
    typeof value !== 'string' ||
    !/^0x(?:0|[1-9a-fA-F][\da-fA-F]*)$/.test(value)
  ) {
    throw new Error('Invalid RPC quantity.');
  }

  return BigInt(value);
}

export class BlockReader {
  requests = 0;
  nextRequestAt: number;
  private readonly requestIntervalMs: number;
  private readonly deadline = Date.now() + 90000;
  private readonly blocks = new Map<bigint, GasBlock>();

  constructor(
    private readonly url: string,
    options: {requestIntervalMs?: number; nextRequestAt?: number} = {},
  ) {
    this.requestIntervalMs = options.requestIntervalMs ?? 0;
    this.nextRequestAt = options.nextRequestAt ?? 0;
  }

  async get(number: bigint | 'latest'): Promise<GasBlock> {
    const cached = number === 'latest' ? undefined : this.blocks.get(number);
    if (cached) return cached;

    const delay = this.nextRequestAt - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));

    const remaining = this.deadline - Date.now();
    if (this.requests >= 40 || remaining <= 0) {
      throw new RpcBudgetExhausted();
    }
    this.requests++;
    this.nextRequestAt = Date.now() + this.requestIntervalMs;

    const response = await fetch(this.url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBlockByNumber',
        params: [
          number === 'latest' ? number : `0x${number.toString(16)}`,
          false,
        ],
      }),
      signal: AbortSignal.timeout(Math.min(10000, remaining)),
    });
    if (!response.ok) {
      const backoff =
        response.status === 429
          ? retryAt(response.headers.get('Retry-After'))
          : undefined;
      await response.body?.cancel();
      if (backoff !== undefined) throw new RpcRateLimited(backoff);
      throw new Error(`Gas sample RPC returned HTTP ${response.status}.`);
    }

    const json = await response.json<{
      result?: {number: unknown; timestamp: unknown; baseFeePerGas: unknown};
    }>();
    if (!json.result) throw new Error('Gas sample RPC did not return a block.');

    const block: GasBlock = {
      number: parseQuantity(json.result.number),
      timestamp: Number(parseQuantity(json.result.timestamp)),
      baseFeePerGas: parseQuantity(json.result.baseFeePerGas).toString(),
    };
    if (!Number.isSafeInteger(block.timestamp)) {
      throw new Error('Gas sample RPC returned an invalid timestamp.');
    }
    if (number !== 'latest' && block.number !== number) {
      throw new Error('Gas sample RPC returned the wrong block number.');
    }

    this.blocks.set(block.number, block);
    return block;
  }
}

// Find the last block at or before the bucket boundary. The 12-second estimate
// only selects a probe; timestamps and adjacent block numbers prove the result.
export async function findBlockAtOrBefore(
  reader: BlockReader,
  timestamp: number,
  upper: GasBlock,
): Promise<GasBlock> {
  if (upper.timestamp <= timestamp) return upper;

  let lower: GasBlock | undefined;
  for (;;) {
    if (lower?.timestamp === timestamp) return lower;
    if (lower && upper.number - lower.number === 1n) return lower;
    if (upper.number === 0n) throw new Error('No block precedes the bucket.');

    const distance = BigInt(
      Math.max(1, Math.ceil((upper.timestamp - timestamp) / 12)),
    );
    let number = upper.number > distance ? upper.number - distance : 0n;
    if (lower) {
      number =
        lower.number +
        (BigInt(timestamp - lower.timestamp) * (upper.number - lower.number)) /
          BigInt(upper.timestamp - lower.timestamp);
      if (number <= lower.number) number = lower.number + 1n;
      if (number >= upper.number) number = upper.number - 1n;
    }

    const block = await reader.get(number);
    if (
      block.timestamp >= upper.timestamp ||
      (lower && block.timestamp <= lower.timestamp)
    ) {
      throw new Error('Gas sample RPC returned inconsistent block timestamps.');
    }
    if (block.timestamp <= timestamp) lower = block;
    else upper = block;
  }
}
