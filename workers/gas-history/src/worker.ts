import {
  CHAIN_ID,
  type GasSample,
  SAMPLE_INTERVAL_SECONDS,
  WEEK_SECONDS,
  addSample,
  summarizeHistory,
} from './history.js';

type Env = {
  GAS_HISTORY: KVNamespace;
  ETHEREUM_RPC_URL: string;
};

const STORAGE_KEY = `samples:${CHAIN_ID}`;

function parseQuantity(value: unknown): bigint {
  if (
    typeof value !== 'string' ||
    !/^0x(?:0|[1-9a-fA-F][\da-fA-F]*)$/.test(value)
  ) {
    throw new Error('Invalid RPC quantity.');
  }

  return BigInt(value);
}

export async function collectSample(
  env: Env,
  scheduledTime: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const timestamp =
    Math.floor(scheduledTime / 1000 / SAMPLE_INTERVAL_SECONDS) *
    SAMPLE_INTERVAL_SECONDS;
  if (timestamp > now || now - timestamp >= SAMPLE_INTERVAL_SECONDS) {
    throw new Error('Gas sampling run is outside its scheduled interval.');
  }

  const response = await fetch(env.ETHEREUM_RPC_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getBlockByNumber',
      params: ['latest', false],
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(`Gas sample RPC returned HTTP ${response.status}.`);

  const json = await response.json<{
    result?: {number: unknown; timestamp: unknown; baseFeePerGas: unknown};
  }>();
  const block = json.result;
  if (!block) throw new Error('Gas sample RPC did not return a block.');

  const blockTimestamp = Number(parseQuantity(block.timestamp));
  if (
    !Number.isSafeInteger(blockTimestamp) ||
    blockTimestamp > now + 60 ||
    blockTimestamp < now - SAMPLE_INTERVAL_SECONDS
  ) {
    throw new Error('Gas sample RPC returned a stale or future block.');
  }

  const sample: GasSample = {
    timestamp,
    blockNumber: parseQuantity(block.number).toString(),
    baseFeePerGas: parseQuantity(block.baseFeePerGas).toString(),
  };
  const samples =
    (await env.GAS_HISTORY.get<GasSample[]>(STORAGE_KEY, 'json')) ?? [];
  const last = samples.at(-1);
  if (last && last.timestamp > sample.timestamp) {
    throw new Error('Gas sampling run is older than the saved history.');
  }
  if (last?.blockNumber === sample.blockNumber) {
    return;
  }

  await env.GAS_HISTORY.put(
    STORAGE_KEY,
    JSON.stringify(addSample(samples, sample)),
    {
      expirationTtl: WEEK_SECONDS + SAMPLE_INTERVAL_SECONDS,
    },
  );
}

export default {
  async fetch(request, env) {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Cache-Control': 'no-store',
    };
    if (new URL(request.url).pathname !== `/api/gas-history/${CHAIN_ID}`) {
      return new Response('Not found', {status: 404, headers});
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, {status: 204, headers});
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', {status: 405, headers});
    }

    try {
      const samples =
        (await env.GAS_HISTORY.get<GasSample[]>(STORAGE_KEY, 'json')) ?? [];
      const body = summarizeHistory(samples, Math.floor(Date.now() / 1000));

      return new Response(
        request.method === 'HEAD' ? null : JSON.stringify(body),
        {
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=60',
          },
        },
      );
    } catch {
      return new Response('Gas history unavailable', {status: 503, headers});
    }
  },
  async scheduled(event, env) {
    await collectSample(env, event.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
