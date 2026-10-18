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
import {ROUTE_SCHEMA, type ViewSwitchingState} from './@routes.js';
import {
  AddressBookService,
  AppPreferencesService,
  ChainService,
  ErrorService,
  EvmCallHistoryService,
  EvmCalldataService,
  EvmTokenService,
  GasHistoryService,
  MonoidCredentialsStore,
  MonoidScanPromptPresenter,
  MonoidStorageService,
  SiteLogoService,
  SolanaTokenService,
  StorageService,
  TransactionHistoryService,
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
    return this.appPreferencesService.then(preferences => {
      const router = routra<typeof ROUTE_SCHEMA, ViewSwitchingState>(
        ROUTE_SCHEMA,
        {},
      );

      router.$use(
        new BrowserRouterPlugin({
          default: router[preferences.defaultFeature ?? 'features'],
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
    });
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
      Uint8Array.from([0xf0, 0x6d, 0x6f, 0x6e, 0x6f, 0x69, 0x64, 0x02, 0x01]),
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
    return Promise.all([
      this.walletKit,
      this.storageService,
      this.addressBookService,
      this.evmCallHistoryService,
      this.transactionHistoryService,
    ]).then(([walletKit, storage, addresses, calls, transactions]) =>
      WalletKitService.create(
        walletKit,
        storage,
        addresses,
        calls,
        transactions,
      ),
    );
  }

  @entrance
  get addressBookService() {
    return this.storageService.then(storage =>
      AddressBookService.create(storage),
    );
  }

  @entrance
  get storageService() {
    return StorageService.create();
  }

  @entrance
  get appPreferencesService() {
    return this.storageService.then(storage =>
      AppPreferencesService.create(storage),
    );
  }

  @entrance
  get siteLogoService() {
    return this.storageService.then(storage => SiteLogoService.create(storage));
  }

  @entrance
  get chainService() {
    return this.storageService.then(storageService =>
      ChainService.create(storageService),
    );
  }

  @entrance
  get evmCalldataService() {
    return this.chainService.then(
      chainService => new EvmCalldataService(chainService),
    );
  }

  @entrance
  get gasHistoryService() {
    return new GasHistoryService(import.meta.env.VITE_GAS_HISTORY_URL);
  }

  @entrance
  get transactionHistoryService() {
    return this.storageService.then(storage =>
      TransactionHistoryService.create(storage),
    );
  }

  @entrance
  get evmTokenService() {
    return Promise.all([this.storageService, this.chainService]).then(
      ([storage, chain]) => EvmTokenService.create(storage, chain),
    );
  }

  @entrance
  get solanaTokenService() {
    return this.storageService.then(storage =>
      SolanaTokenService.create(storage),
    );
  }

  @entrance
  get evmCallHistoryService() {
    return this.storageService.then(storage =>
      EvmCallHistoryService.create(storage),
    );
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
    return this.storageService.then(storageService =>
      MonoidCredentialsStore.create(storageService),
    );
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
