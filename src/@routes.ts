import type {Router as RoutraRouter, SchemaRecord} from 'routra';

import type {SafeIndexHex} from './@atomics.js';
import type {ScannedCardData} from './@components/views/safe/index.js';
import type {EvmTransactionReplacementKind} from './@lib/evm-transaction-replacement.js';
import type {CardInformation} from './@lib/global-platform/card-information.js';
import type {MonoidAppletInstallation} from './@lib/monoid/index.js';
import type {AddressChain} from './@lib/wallet-address.js';
import type {WalletConnectAuthentication} from './@lib/wallet-connect-authentication.js';
import {createFlowId} from './@utils/index.js';

export const ROUTE_SCHEMA = {
  features: true,
  otp: {
    account: {$state: (state: {index: SafeIndexHex}) => state},
    $state: (
      state:
        | {card?: Pick<ScannedCardData, 'id' | 'publicKey'>; importId?: string}
        | undefined,
    ) => state ?? {},
  },
  securityKey: {
    $state: (
      state: {card?: Pick<ScannedCardData, 'id' | 'publicKey'>} | undefined,
    ) => state ?? {},
  },
  cardApplets: {
    $state: (
      state:
        | {
            cardInformation?: CardInformation;
            /** Read during the scan that opened Card Applets for this card. */
            installation?: MonoidAppletInstallation;
            returnTo?:
              | 'safe'
              | 'copy'
              | 'bundle'
              | 'bundleExtension'
              | 'securityKey'
              | 'otp';
            copyId?: string;
            bundleId?: string;
            extensionId?: string;
            maintenanceSyncId?: string;
          }
        | undefined,
    ) => ({...state, maintenanceSyncId: state?.maintenanceSyncId}),
  },
  bitcoin: {
    wallet: {
      $state: undefined! as {address: string},
      send: true,
      transactions: true,
      transaction: {
        $state: undefined! as {txid: string},
      },
    },
  },
  sessions: {
    request: {
      $state: undefined! as {id: number},
    },
    transaction: {
      $state: undefined! as {
        id: number;
        topic: string;
        signedTransaction: string;
      },
    },
    solanaTransaction: {
      $state: undefined! as {
        id: number;
        topic: string;
        chainId: string;
        address: string;
        signedTransaction: string;
      },
    },
    session: {
      $state: undefined! as {topic: string},
      switchAccounts: true,
    },
  },
  ethereum: {
    wallet: {
      $state: undefined! as {
        address: string;
      },
      transaction: {
        $state: undefined! as {chainId: string; hash: string},
        replace: {
          $state: undefined! as {kind: EvmTransactionReplacementKind},
        },
      },
    },
  },
  solana: {
    wallet: {
      $state: undefined! as {address: string},
      transaction: {
        $state: undefined! as {chainId: string; id: string},
      },
    },
  },
  scan: {
    connection: {
      $state: ({id}: {id: number}) => ({id, addresses: [] as string[]}),
      authentication: {
        $state: undefined! as {
          addresses: string[];
          authentication: WalletConnectAuthentication[];
        },
      },
    },
  },
  safe: {
    rawKey: {
      $state: undefined! as {
        index: SafeIndexHex;
      },
      derive: true,
    },
    derivableKey: {
      $state: ({index}: {index: SafeIndexHex}) => ({
        index,
        expandedChain: undefined as AddressChain | undefined,
      }),
      derive: true,
    },
    scanCard: true,
    copyItems: {
      $state: undefined! as {
        copyId: string;
        sourceCard?: ScannedCardData;
        sourceIndexes?: SafeIndexHex[];
      },
    },
    syncCards: {
      $state: (state: {
        card?: Pick<ScannedCardData, 'id' | 'publicKey'>;
        syncId?: string;
      }) => ({...state, syncId: state.syncId ?? createFlowId()}),
    },
    setupCard: {
      $state: (state: {
        cardInformation?: CardInformation;
        card?: Pick<ScannedCardData, 'id' | 'publicKey'>;
        bundle?: 'card' | 'authority';
        copyId?: string;
        bundleId?: string;
      }) => ({
        ...state,
        bundleId: state.bundleId ?? createFlowId(),
      }),
    },
    extendBundle: {
      $state: (state: {
        card: Pick<
          ScannedCardData,
          | 'id'
          | 'publicKey'
          | 'bundle'
          | 'alias'
          | 'allowPeerExtension'
          | 'authority'
        >;
        extensionId?: string;
      }) => ({...state, extensionId: state.extensionId ?? createFlowId()}),
    },
    card: {
      $state: undefined! as {
        card?: Pick<ScannedCardData, 'id' | 'publicKey'>;
      },
    },
  },
} satisfies SchemaRecord;

export type ViewSwitchingState = {
  progress: number;
  settling?: boolean;
};

export type Router = RoutraRouter<typeof ROUTE_SCHEMA, ViewSwitchingState>;
