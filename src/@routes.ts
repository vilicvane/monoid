import type {Router as RoutraRouter, SchemaRecord} from 'routra';

import type {MonoidIdHex, MonoidSafeIdHex, SafeIndexHex} from './@atomics.js';
import type {ScannedCardData} from './@components/views/safe/index.js';
import type {EvmTransactionReplacementKind} from './@lib/evm-transaction-replacement.js';
import type {AddressChain} from './@lib/wallet-address.js';
import type {WalletConnectAuthentication} from './@lib/wallet-connect-authentication.js';

export const ROUTE_SCHEMA = {
  features: true,
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
    session: {
      $state: undefined! as {topic: string},
      switchAccounts: true,
    },
  },
  transactions: {
    wallet: {
      $state: undefined! as {address: string},
      transaction: {
        $state: undefined! as {chainId: string; hash: string},
        replace: {
          $state: undefined! as {kind: EvmTransactionReplacementKind},
        },
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
    },
    derivableKey: {
      $state: ({index}: {index: SafeIndexHex}) => ({
        index,
        expandedChain: undefined as AddressChain | undefined,
      }),
      derive: true,
    },
    scanCard: true,
    installApplet: true,
    setupCard: {
      $state: undefined! as {
        id: MonoidIdHex;
        pin: boolean;
        safe: {
          id: MonoidSafeIdHex;
          pin: boolean;
          unlocked: boolean;
        };
      },
    },
    card: {
      $state: undefined! as {
        card?: ScannedCardData;
      },
    },
  },
} satisfies SchemaRecord;

export type ViewSwitchingState = {
  progress: number;
  settling?: boolean;
};

export type Router = RoutraRouter<typeof ROUTE_SCHEMA, ViewSwitchingState>;
