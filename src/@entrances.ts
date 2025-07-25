import {WalletKit} from '@reown/walletkit';
import {Core} from '@walletconnect/core';
import type {UpEntrances as UpEntrances_} from 'entrance-decorator';
import {entrance} from 'entrance-decorator';
import {createContext} from 'react';

import {
  StorageService,
  WalletKitService,
  WalletStorageService,
} from './@services/index.js';

export class Entrances {
  /* eslint-disable @typescript-eslint/explicit-function-return-type */

  @entrance
  get walletKit() {
    return WalletKit.init({
      core: new Core({
        projectId: 'f1bac1f17e8531e322bd69250c6cc7b4',
      }),
      metadata: {
        name: 'Monoid',
        description: 'A smart identity gateway.',
        url: 'https://monoid.app',
        icons: [
          'https://raw.githubusercontent.com/vilicvane/monoid-javacard/master/res/monoid.png',
        ],
      },
    });
  }

  @entrance
  get walletKitService() {
    return this.walletKit.then(walletKit => {
      return new WalletKitService(walletKit);
    });
  }

  @entrance
  get storageService() {
    return StorageService.create();
  }

  @entrance
  get walletStorageService() {
    return this.storageService.then(
      storageService => new WalletStorageService(storageService),
    );
  }

  /* eslint-enable @typescript-eslint/explicit-function-return-type */
}

export type UpEntrances = UpEntrances_<Entrances, '*', never>;

export const EntrancesContext = createContext<UpEntrances>(undefined!);
