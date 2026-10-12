import type {Router as RoutraRouter, SchemaRecord} from 'routra';

import type {MonoidIdHex, MonoidSafeIdHex, SafeIndexHex} from './@atomics.js';
import type {ScannedCardData} from './@components/views/safe/index.js';

export const ROUTE_SCHEMA = {
  sessions: true,
  scan: true,
  safe: {
    rawKey: {
      $state: undefined! as {
        index: SafeIndexHex;
      },
    },
    derivableKey: {
      $state: undefined! as {
        index: SafeIndexHex;
      },
      derive: true,
    },
    scanCard: true,
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
        card: ScannedCardData;
      },
    },
  },
} satisfies SchemaRecord;

export type Router = RoutraRouter<typeof ROUTE_SCHEMA, {}>;
