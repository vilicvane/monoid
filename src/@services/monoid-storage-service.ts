import type {MonoidSafeIdHex} from '../@atomics.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    monoids: MonoidData[];
  }
}

export class MonoidStorageService {}

export type MonoidData = {
  id: MonoidSafeIdHex;
};
