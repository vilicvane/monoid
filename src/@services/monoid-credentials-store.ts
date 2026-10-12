import type {MonoidIdHex, MonoidPIN} from '../@atomics.js';

import type {StorageService} from './storage-service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    monoidPINs: Record<MonoidIdHex, MonoidPIN>;
  }
}

export class MonoidCredentialsStore {
  constructor(private storage: StorageService) {}

  async getPIN(id: MonoidIdHex): Promise<MonoidPIN | undefined> {
    const pins = await this.storage.get('monoidPINs');

    return pins?.[id];
  }

  async setPIN(id: MonoidIdHex, pin: MonoidPIN): Promise<void> {
    const pins = await this.storage.get('monoidPINs');

    await this.storage.set('monoidPINs', {...pins, [id]: pin});
  }

  async removePIN(id: MonoidIdHex): Promise<void> {
    const pins = {...(await this.storage.get('monoidPINs'))};

    delete pins[id];

    await this.storage.set('monoidPINs', pins);
  }
}
