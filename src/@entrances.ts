import {WalletKit} from '@reown/walletkit';
import {Core} from '@walletconnect/core';
import type {UpEntrances as UpEntrances_} from 'entrance-decorator';
import {entrance} from 'entrance-decorator';
import {createContext, useContext} from 'react';
import {routra} from 'routra';
import {BrowserHistory, BrowserRouterPlugin} from 'routra/browser';

import {Keyboard} from './@keyboard.js';
import {createMonoidApplet} from './@lib/monoid/index.js';
import {Portals} from './@portals.js';
import {ROUTE_SCHEMA} from './@routes.js';
import {
  ErrorService,
  MonoidCredentialsStore,
  MonoidScanPromptPresenter,
  MonoidStorageService,
  StorageService,
  WalletKitService,
  WalletStorageService,
} from './@services/index.js';

export class Entrances {
  /* eslint-disable @typescript-eslint/explicit-function-return-type */

  @entrance
  get history() {
    return new BrowserHistory();
  }

  @entrance
  get router() {
    const router = routra(ROUTE_SCHEMA);

    router.$use(
      new BrowserRouterPlugin({
        default: router.sessions,
        history: this.history,
        segments: {
          encodeState(state) {
            return JSON.stringify(state, (_key, value) => {
              if (value instanceof Uint8Array) {
                return {
                  $type: 'Uint8Array',
                  value: Array.from(value),
                };
              }

              return value;
            });
          },
          decodeState(state) {
            return JSON.parse(state, (_key, value) => {
              if (value && typeof value === 'object' && '$type' in value) {
                if (value.$type === 'Uint8Array') {
                  return Uint8Array.from(value.value);
                }
              }

              return value;
            });
          },
        },
      }),
    );

    return router;
  }

  @entrance
  get keyboard() {
    return new Keyboard();
  }

  @entrance
  get portals() {
    return new Portals();
  }

  @entrance
  get monoidApplet() {
    return createMonoidApplet(
      Uint8Array.from([0xf0, 0x6d, 0x6f, 0x6e, 0x6f, 0x69, 0x64, 0x01, 0x01]),
    );
  }

  @entrance
  get monoidScanPromptPresenter() {
    return new MonoidScanPromptPresenter();
  }

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
    return this.storageService.then(storageService =>
      WalletStorageService.create(storageService),
    );
  }

  @entrance
  get monoidStorageService() {
    return this.storageService.then(
      storageService => new MonoidStorageService(storageService),
    );
  }

  @entrance
  get monoidCredentialsStore() {
    return this.storageService.then(() => new MonoidCredentialsStore());
  }

  @entrance
  get errorService() {
    return new ErrorService();
  }

  /* eslint-enable @typescript-eslint/explicit-function-return-type */
}

export type UpEntrances = UpEntrances_<Entrances, '*', never>;

export const EntrancesContext = createContext<UpEntrances>(undefined!);

export function useEntrances(): UpEntrances {
  return useContext(EntrancesContext);
}
