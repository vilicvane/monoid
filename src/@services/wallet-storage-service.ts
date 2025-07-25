import type {StorageService} from './index.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface WalletStorageMapping {
    wallets: WalletData[];
  }
}

export class WalletStorageService {
  constructor(private storage: StorageService) {}
}

export type WalletData = {
  alias: string;
  index: string;
};
