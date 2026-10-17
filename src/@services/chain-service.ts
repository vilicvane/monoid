import {
  ChainstackProvider,
  InfuraProvider,
  JsonRpcProvider,
  Network,
} from 'ethers';
import {observable, runInAction} from 'mobx';
import ms from 'ms';

import {
  BUILTIN_CHAIN_CURRENCIES,
  BUILTIN_CHAIN_EXPLORERS,
  BUILTIN_CHAIN_ICONS,
  BUILTIN_CHAIN_NAMES,
  type ChainDirectory,
  type NativeCurrency,
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
  private explorers = observable.map<string, string>([], {deep: false});
  private currencies = observable.map<string, NativeCurrency>([], {
    deep: false,
  });
  private providers = new Map<string, Promise<JsonRpcProvider>>();
  private refreshAfter: number;
  private refreshing: Promise<void> | undefined;

  constructor(
    private storage: StorageService,
    cache?: StorageMapping['chainDirectory'],
  ) {
    runInAction(() => {
      this.names.replace({...BUILTIN_CHAIN_NAMES, ...cache?.names});
      this.icons.replace({...BUILTIN_CHAIN_ICONS, ...cache?.icons});
      this.explorers.replace({...BUILTIN_CHAIN_EXPLORERS, ...cache?.explorers});
      this.currencies.replace({
        ...BUILTIN_CHAIN_CURRENCIES,
        ...cache?.currencies,
      });
    });
    this.refreshAfter = cache ? cache.updatedAt + CACHE_DURATION : 0;
  }

  getChainName(chainId: string): string | undefined {
    return this.names.get(chainId);
  }

  getChainIcon(chainId: string): string | undefined {
    return this.icons.get(chainId);
  }

  getNativeCurrency(chainId: string): NativeCurrency | undefined {
    return this.currencies.get(chainId);
  }

  getTransactionExplorerURL(chainId: string, hash: string): string | undefined {
    const explorer = this.explorers.get(chainId);
    return explorer ? `${explorer}/tx/${hash}` : undefined;
  }

  getRPC(chainId: string): Promise<JsonRpcProvider> {
    let provider = this.providers.get(chainId);
    if (!provider) {
      provider = this.createRPC(chainId).catch((error: unknown) => {
        this.providers.delete(chainId);
        throw error;
      });
      this.providers.set(chainId, provider);
    }
    return provider;
  }

  private async createRPC(chainId: string): Promise<JsonRpcProvider> {
    if (!/^eip155:[1-9]\d*$/.test(chainId)) {
      throw new Error('This network does not support EVM transactions.');
    }
    const network = Network.from(BigInt(chainId.split(':')[1]!));
    let failure: unknown = new Error('No RPC is available for this network.');

    for (const Provider of [ChainstackProvider, InfuraProvider]) {
      let provider: JsonRpcProvider | undefined;
      try {
        const request = Provider.getRequest(network);
        request.timeout = REQUEST_TIMEOUT;
        request.setThrottleParams({maxAttempts: 2});

        provider = new JsonRpcProvider(request, network);
        await provider.getNetwork();
        return provider;
      } catch (error) {
        provider?.destroy();
        failure = error;
      }
    }

    throw failure;
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
        this.explorers.replace({
          ...BUILTIN_CHAIN_EXPLORERS,
          ...directory.explorers,
        });
        this.currencies.replace({
          ...BUILTIN_CHAIN_CURRENCIES,
          ...directory.currencies,
        });
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
