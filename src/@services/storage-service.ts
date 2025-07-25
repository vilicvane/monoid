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
    return value;
  }

  async set<TKey extends keyof StorageMapping>(
    key: TKey,
    value: StorageMapping[TKey],
  ): Promise<void> {
    await this.storage.set(key, value);
  }

  static async create(): Promise<StorageService> {
    const storage = new Storage();
    await storage.create();
    return new StorageService(storage);
  }
}
