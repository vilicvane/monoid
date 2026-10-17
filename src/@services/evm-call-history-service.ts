import {observable, runInAction} from 'mobx';

import type {StorageService} from './storage-service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    signedEvmCalls: string[];
  }
}

export class EvmCallHistoryService {
  private calls = observable.set<string>([]);
  private writing = Promise.resolve();

  private constructor(
    private storage: StorageService,
    saved: StorageMapping['signedEvmCalls'] = [],
  ) {
    runInAction(() => this.calls.replace(saved));
  }

  hasSigned(
    chainId: string,
    contractAddress: string,
    signature: string,
  ): boolean {
    return this.calls.has(callKey(chainId, contractAddress, signature));
  }

  rememberSigned(
    chainId: string,
    calls: readonly {contractAddress: string; signature: string}[],
  ): Promise<void> {
    if (!calls.length) return Promise.resolve();

    runInAction(() => {
      for (const {contractAddress, signature} of calls) {
        this.calls.add(callKey(chainId, contractAddress, signature));
      }
    });
    return this.save();
  }

  private save(): Promise<void> {
    // Retry the full history after a failed write, including repeated calls.
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        await this.storage.set('signedEvmCalls', [...this.calls]);
      });
    return this.writing;
  }

  static async create(storage: StorageService): Promise<EvmCallHistoryService> {
    const saved = await storage.get('signedEvmCalls');
    return new EvmCallHistoryService(storage, saved ?? []);
  }
}

function callKey(
  chainId: string,
  contractAddress: string,
  signature: string,
): string {
  return `${chainId}:${contractAddress.toLowerCase()}:${signature}`;
}
