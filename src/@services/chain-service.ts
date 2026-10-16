import {observable, runInAction} from 'mobx';
import ms from 'ms';

import {
  BUILTIN_CHAIN_ICONS,
  BUILTIN_CHAIN_NAMES,
  type ChainDirectory,
  parseChainDirectory,
} from '../@lib/chain-names.js';

import type {StorageService} from './storage-service.js';

const CHAIN_DIRECTORY_URL = 'https://chainlist.org/rpcs.json';
const CACHE_DURATION = ms('24h');
const RETRY_DELAY = ms('5m');
const REQUEST_TIMEOUT = ms('10s');

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    chainDirectory: ChainDirectory & {updatedAt: number};
  }
}

export class ChainService {
  private names = observable.map<string, string>([], {deep: false});
  private icons = observable.map<string, string>([], {deep: false});
  private refreshAfter: number;
  private refreshing: Promise<void> | undefined;

  constructor(
    private storage: StorageService,
    cache?: StorageMapping['chainDirectory'],
  ) {
    runInAction(() => {
      this.names.replace({...BUILTIN_CHAIN_NAMES, ...cache?.names});
      this.icons.replace({...BUILTIN_CHAIN_ICONS, ...cache?.icons});
    });
    this.refreshAfter = cache ? cache.updatedAt + CACHE_DURATION : 0;
  }

  getChainName(chainId: string): string | undefined {
    return this.names.get(chainId);
  }

  getChainIcon(chainId: string): string | undefined {
    return this.icons.get(chainId);
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (Date.now() < this.refreshAfter) return Promise.resolve();

    this.refreshing = this.refreshDirectory()
      .catch((error: unknown) => {
        this.refreshAfter = Date.now() + RETRY_DELAY;
        throw error;
      })
      .finally(() => {
        this.refreshing = undefined;
      });

    return this.refreshing;
  }

  private async refreshDirectory(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const response = await fetch(CHAIN_DIRECTORY_URL, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Could not load network information: HTTP ${response.status}.`,
        );
      }

      const directory = parseChainDirectory(await response.json());
      const updatedAt = Date.now();

      runInAction(() => {
        this.names.replace({...BUILTIN_CHAIN_NAMES, ...directory.names});
        this.icons.replace({...BUILTIN_CHAIN_ICONS, ...directory.icons});
      });
      this.refreshAfter = updatedAt + CACHE_DURATION;
      await this.storage
        .set('chainDirectory', {updatedAt, ...directory})
        .catch(console.warn);
    } finally {
      clearTimeout(timeout);
    }
  }

  static async create(storage: StorageService): Promise<ChainService> {
    let cache: StorageMapping['chainDirectory'] | undefined;

    try {
      cache = await storage.get('chainDirectory');
    } catch (error) {
      console.warn(error);
    }

    const service = new ChainService(storage, cache);
    void service.refresh().catch(console.warn);
    return service;
  }
}
