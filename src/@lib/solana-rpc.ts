import type {SolanaRPCRequest} from './solana-transaction-review.js';

const REQUEST_TIMEOUT = 15_000;

type RPCResponse = {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: {code: number; message: string; data?: unknown};
};

export class SolanaRPCError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: {code: number; message: string; data?: unknown}) {
    super(`Solana RPC: ${error.message}`);
    this.name = 'SolanaRPCError';
    this.code = error.code;
    this.data = error.data;
  }
}

export function createSolanaRPC(
  chainId: string,
  projectId: string,
  fetchRequest: typeof fetch = fetch,
): SolanaRPCRequest {
  if (!/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(chainId)) {
    throw new Error('Invalid Solana network.');
  }

  const url = new URL('https://rpc.walletconnect.org/v1');
  url.searchParams.set('chainId', chainId);
  url.searchParams.set('projectId', projectId);
  let nextRequestId = 0;
  let verified = false;

  const request: SolanaRPCRequest = async (method, params, signal) => {
    signal?.throwIfAborted();
    const id = ++nextRequestId;
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, {once: true});
    const timeout = setTimeout(
      () => controller.abort(new Error('The Solana RPC request timed out.')),
      REQUEST_TIMEOUT,
    );

    try {
      const response = await fetchRequest(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id, method, params}),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => undefined)) as
        | RPCResponse
        | undefined;
      controller.signal.throwIfAborted();

      if (body?.error && typeof body.error.message === 'string') {
        if (
          body.jsonrpc === '2.0' &&
          body.id === id &&
          Number.isInteger(body.error.code) &&
          !('result' in body)
        ) {
          throw new SolanaRPCError(body.error);
        }

        throw new Error(`Solana RPC: ${body.error.message}`);
      }
      if (!response.ok) {
        throw new Error(`Solana RPC: HTTP ${response.status}.`);
      }
      if (
        !body ||
        typeof body !== 'object' ||
        body.jsonrpc !== '2.0' ||
        body.id !== id ||
        !('result' in body)
      ) {
        throw new Error('Invalid Solana RPC response.');
      }

      return body.result;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  };

  return async (method, params, signal) => {
    signal?.throwIfAborted();

    if (!verified) {
      const genesisHash = await request('getGenesisHash', [], signal);

      if (
        typeof genesisHash !== 'string' ||
        genesisHash.slice(0, 32) !== chainId.slice(7)
      ) {
        throw new Error('The Solana RPC returned a different network.');
      }

      verified = true;
    }

    return request(method, params, signal);
  };
}
