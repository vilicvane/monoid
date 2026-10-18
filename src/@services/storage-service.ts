import {Storage} from '@ionic/storage';

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {}
}

export class StorageService {
  private constructor(private storage: Storage) {}

  async get<TKey extends keyof StorageMapping>(
    key: TKey,
  ): Promise<StorageMapping[TKey] | undefined> {
    const value = await this.storage.get(key);
    return value ?? undefined;
  }

  async set<TKey extends keyof StorageMapping>(
    key: TKey,
    value: StorageMapping[TKey],
  ): Promise<void> {
    await this.storage.set(key, value);
  }

  async remove(key: keyof StorageMapping): Promise<void> {
    await this.storage.remove(key);
  }

  static async create(): Promise<StorageService> {
    const storage = new Storage();
    await storage.create();

    // Retire the development PIN cache. Credentials are re-entered and saved in BiometricVault.
    await storage.remove('monoidPINs');

    // Backup progress now belongs to the open page only.
    await storage.remove('cardBackup');

    return new StorageService(storage);
  }
}
