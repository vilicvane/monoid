import {observable, runInAction} from 'mobx';
import ms from 'ms';

import {
  type EvmToken,
  parseEvmTokenList,
  readEvmToken,
} from '../@lib/evm-token.js';

import type {ChainService} from './chain-service.js';
import type {StorageService} from './storage-service.js';

const TOKEN_LIST_URL = 'https://tokens.uniswap.org';
const CACHE_DURATION = ms('24h');
const RETRY_DELAY = ms('5m');
const REQUEST_TIMEOUT = ms('10s');

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    evmTokenList: {tokens: EvmToken[]; updatedAt: number};
  }
}

export class EvmTokenService {
  private tokens = observable.map<string, EvmToken>([], {deep: false});
  private refreshAfter: number;
  private refreshing: Promise<void> | undefined;
  private discovered = observable.map<string, EvmToken>([], {deep: false});
  private lookups = new Map<
    string,
    {promise: Promise<void>; expires: number}
  >();

  constructor(
    private storage: StorageService,
    private chainService: Pick<ChainService, 'getRPC'>,
    cache?: StorageMapping['evmTokenList'],
  ) {
    this.replace(cache?.tokens ?? []);
    this.refreshAfter = cache ? cache.updatedAt + CACHE_DURATION : 0;
  }

  getToken(chainId: string, address: string): EvmToken | undefined {
    const key = `${chainId}:${address.toLowerCase()}`;
    return this.tokens.get(key) ?? this.discovered.get(key);
  }

  isListed(chainId: string, address: string): boolean {
    return this.tokens.has(`${chainId}:${address.toLowerCase()}`);
  }

  resolve(chainId: string, address: string): Promise<void> {
    if (this.isListed(chainId, address)) return Promise.resolve();
    const key = `${chainId}:${address.toLowerCase()}`;
    const existing = this.lookups.get(key);
    if (existing && Date.now() < existing.expires) return existing.promise;

    const promise = this.chainService
      .getRPC(chainId)
      .then(provider => readEvmToken(provider, chainId, address))
      .then(token => {
        runInAction(() => this.discovered.set(key, token));
      })
      .catch(() => {
        // Unavailable metadata or a non-ERC-20 target keeps its raw call view.
        runInAction(() => this.discovered.delete(key));
      });
    this.lookups.set(key, {promise, expires: Date.now() + RETRY_DELAY});
    return promise;
  }

  private replace(tokens: EvmToken[]): void {
    runInAction(() => {
      this.tokens.replace(
        tokens.map(token => [
          `eip155:${token.chainId}:${token.address.toLowerCase()}`,
          token,
        ]),
      );
    });
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (Date.now() < this.refreshAfter) return Promise.resolve();

    this.refreshing = this.refreshList()
      .catch((error: unknown) => {
        this.refreshAfter = Date.now() + RETRY_DELAY;
        throw error;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  private async refreshList(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const response = await fetch(TOKEN_LIST_URL, {signal: controller.signal});
      if (!response.ok) {
        throw new Error(
          `Could not load token information: HTTP ${response.status}.`,
        );
      }
      const tokens = parseEvmTokenList(await response.json());
      const updatedAt = Date.now();

      this.replace(tokens);
      this.refreshAfter = updatedAt + CACHE_DURATION;
      await this.storage
        .set('evmTokenList', {tokens, updatedAt})
        .catch(console.warn);
    } finally {
      clearTimeout(timeout);
    }
  }

  static async create(
    storage: StorageService,
    chainService: Pick<ChainService, 'getRPC'>,
  ): Promise<EvmTokenService> {
    let cache: StorageMapping['evmTokenList'] | undefined;
    try {
      cache = await storage.get('evmTokenList');
    } catch (error) {
      console.warn(error);
    }

    const service = new EvmTokenService(storage, chainService, cache);
    void service.refresh().catch(console.warn);
    return service;
  }
}
