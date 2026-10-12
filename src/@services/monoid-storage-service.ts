import type {MonoidIdHex} from '../@atomics.js';

import type {StorageService} from './storage-service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    monoids: MonoidData[];
  }
}

export class MonoidStorageService {
  constructor(storage: StorageService) {}
}

export type MonoidData = {
  id: MonoidIdHex;
};
