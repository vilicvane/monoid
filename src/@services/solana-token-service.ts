import {base58} from '@scure/base';
import {observable, runInAction} from 'mobx';
import ms from 'ms';

import {SOLANA_TOKEN_PROGRAM} from '../@lib/solana-token-instruction.js';

import type {StorageService} from './storage-service.js';

const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const TOKEN_SEARCH_URL = 'https://api.jup.ag/tokens/v2/search';
const CACHE_DURATION = ms('24h');
const RETRY_DELAY = ms('5m');
const REQUEST_TIMEOUT = ms('10s');
const REQUEST_INTERVAL = ms('2s');

export type SolanaTokenMetadata = {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    solanaTokenMetadata: Record<
      string,
      {token: SolanaTokenMetadata; updatedAt: number}
    >;
  }
}

export class SolanaTokenService {
  private tokens = observable.map<string, SolanaTokenMetadata>([], {
    deep: false,
  });
  private pending = new Map<string, Promise<void>>();
  private retryAfter = new Map<string, number>();
  private queue = Promise.resolve();
  private nextRequestAt = 0;

  constructor(
    private storage: StorageService,
    private cache: StorageMapping['solanaTokenMetadata'] = {},
    private fetchRequest: typeof fetch = fetch,
  ) {
    runInAction(() => {
      this.tokens.replace(
        Object.values(cache).map(({token}) => [token.address, token]),
      );
    });
  }

  getToken(chainId: string, mint: string): SolanaTokenMetadata | undefined {
    return chainId === MAINNET ? this.tokens.get(mint) : undefined;
  }

  resolve(chainId: string, addresses: readonly string[]): Promise<void> {
    if (chainId !== MAINNET) return Promise.resolve();

    const waiting = new Set<Promise<void>>();
    const missing: string[] = [];

    for (const address of new Set(addresses)) {
      if (!isMintAddress(address)) continue;

      const pending = this.pending.get(address);
      if (pending) {
        waiting.add(pending);
      } else if (
        Date.now() >=
        Math.max(
          this.cache[address]
            ? this.cache[address].updatedAt + CACHE_DURATION
            : 0,
          this.retryAfter.get(address) ?? 0,
        )
      ) {
        missing.push(address);
      }
    }

    for (let offset = 0; offset < missing.length; offset += 100) {
      const batch = missing.slice(offset, offset + 100);
      const promise = this.queue.then(() => this.load(batch));
      this.queue = promise;
      waiting.add(promise);
      for (const address of batch) this.pending.set(address, promise);
    }

    return Promise.all(waiting).then(() => undefined);
  }

  private async load(addresses: readonly string[]): Promise<void> {
    const delay = this.nextRequestAt - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    this.nextRequestAt = Date.now() + REQUEST_INTERVAL;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const response = await this.fetchRequest(
        `${TOKEN_SEARCH_URL}?query=${addresses.join(',')}`,
        {signal: controller.signal},
      );
      if (!response.ok) return;

      const value: unknown = await response.json();
      if (!Array.isArray(value)) return;

      const requested = new Set(addresses);
      const tokens = value.flatMap((entry: unknown) => {
        const token = parseToken(entry, requested);
        return token ? [token] : [];
      });
      const updatedAt = Date.now();

      runInAction(() => {
        for (const token of tokens) {
          this.tokens.set(token.address, token);
          this.cache[token.address] = {token, updatedAt};
        }
      });
      if (tokens.length) {
        await this.storage
          .set('solanaTokenMetadata', this.cache)
          .catch(console.warn);
      }
    } catch {
      // Metadata is optional; signing keeps the mint and original amount.
    } finally {
      clearTimeout(timeout);
      for (const address of addresses) {
        this.pending.delete(address);
        this.retryAfter.set(address, Date.now() + RETRY_DELAY);
      }
    }
  }

  static async create(storage: StorageService): Promise<SolanaTokenService> {
    let cache: StorageMapping['solanaTokenMetadata'] | undefined;
    try {
      cache = await storage.get('solanaTokenMetadata');
    } catch (error) {
      console.warn(error);
    }
    return new SolanaTokenService(storage, cache);
  }
}

function isMintAddress(address: string): boolean {
  try {
    return base58.decode(address).length === 32;
  } catch {
    return false;
  }
}

function parseToken(
  value: unknown,
  requested: ReadonlySet<string>,
): SolanaTokenMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as Record<string, unknown>;

  if (
    typeof entry.id !== 'string' ||
    !requested.has(entry.id) ||
    entry.tokenProgram !== SOLANA_TOKEN_PROGRAM ||
    typeof entry.name !== 'string' ||
    !entry.name.trim() ||
    entry.name.length > 128 ||
    typeof entry.symbol !== 'string' ||
    !entry.symbol.trim() ||
    entry.symbol.length > 32 ||
    typeof entry.decimals !== 'number' ||
    !Number.isInteger(entry.decimals) ||
    entry.decimals < 0 ||
    entry.decimals > 255
  ) {
    return undefined;
  }

  let logoURI: string | undefined;
  if (typeof entry.icon === 'string') {
    try {
      const url = new URL(entry.icon);
      if (url.protocol === 'https:' && !url.username && !url.password) {
        logoURI = url.href;
      }
    } catch {
      // An invalid image URL does not invalidate the token's text metadata.
    }
  }

  return {
    address: entry.id,
    name: entry.name.trim(),
    symbol: entry.symbol.trim(),
    decimals: entry.decimals,
    logoURI,
  };
}
