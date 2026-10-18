import {Capacitor, CapacitorHttp} from '@capacitor/core';

import {
  type SolanaIdl,
  decodeSolanaIdlInstruction,
  parseSolanaIdl,
} from '../@lib/solana-idl.js';
import type {SolanaTransactionReview} from '../@lib/solana-transaction-review.js';

const IDL_URL = 'https://idl.solana.com/api/idl';
const REQUEST_TIMEOUT = 8000;
const REQUEST_CONCURRENCY = 3;

export class SolanaIdlService {
  async decode(
    chainId: string,
    reviews: readonly SolanaTransactionReview[],
    signal?: AbortSignal,
  ): Promise<SolanaTransactionReview[]> {
    signal?.throwIfAborted();
    const cluster =
      chainId === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
        ? 'mainnet-beta'
        : chainId === 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
          ? 'devnet'
          : undefined;
    if (!cluster) return [...reviews];

    const programs = new Set(
      reviews.flatMap(review =>
        review.instructions.flatMap(instruction =>
          instruction.decoded.kind === 'unknown'
            ? [instruction.programAddress]
            : [],
        ),
      ),
    );
    const pending = programs.values();
    const idls = new Map<string, SolanaIdl>();
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, {once: true});
    const timeout = setTimeout(() => {
      controller.abort(
        new DOMException('IDL lookup timed out.', 'TimeoutError'),
      );
    }, REQUEST_TIMEOUT);

    try {
      await Promise.all(
        Array.from(
          {length: Math.min(programs.size, REQUEST_CONCURRENCY)},
          async () => {
            for (const program of pending) {
              if (controller.signal.aborted) break;
              const idl = await this.getIdl(
                program,
                cluster,
                controller.signal,
              );
              if (idl) idls.set(program, idl);
            }
          },
        ),
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
    signal?.throwIfAborted();

    return reviews.map(review => ({
      ...review,
      instructions: review.instructions.map(instruction => {
        if (instruction.decoded.kind !== 'unknown') return instruction;
        const idl = idls.get(instruction.programAddress);
        const decoded = idl && decodeSolanaIdlInstruction(idl, instruction);
        return decoded ? {...instruction, idl: decoded} : instruction;
      }),
    }));
  }

  private async getIdl(
    program: string,
    cluster: string,
    signal: AbortSignal,
  ): Promise<SolanaIdl | undefined> {
    let rejectAborted: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = () => reject(signal.reason);
      signal.addEventListener('abort', rejectAborted, {once: true});
    });

    try {
      const native = Capacitor.isNativePlatform();
      const endpoint =
        !native && import.meta.env?.DEV ? '/api/solana-idl' : IDL_URL;
      const url = `${endpoint}?${new URLSearchParams({programId: program, cluster})}`;
      const response: unknown = await Promise.race([
        getResponse(url, native, signal),
        aborted,
      ]);
      signal.throwIfAborted();
      if (!response || typeof response !== 'object') return undefined;
      const value = response as Record<string, unknown>;
      if (value.programId !== program || value.valid !== true) return undefined;
      return parseSolanaIdl(value.idl, program);
    } catch {
      // IDL discovery is optional; unresolved programs retain the raw review.
      return undefined;
    } finally {
      signal.removeEventListener('abort', rejectAborted);
    }
  }
}

async function getResponse(
  url: string,
  native: boolean,
  signal: AbortSignal,
): Promise<unknown> {
  if (native) {
    const response = await CapacitorHttp.get({
      url,
      responseType: 'json',
      connectTimeout: REQUEST_TIMEOUT,
      readTimeout: REQUEST_TIMEOUT,
    });
    return response.status >= 200 && response.status < 300
      ? (response.data as unknown)
      : undefined;
  }

  const response = await fetch(url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal,
  });
  return response.ok ? response.json() : undefined;
}
