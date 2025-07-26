import type {Router as RoutraRouter, SchemaRecord} from 'routra';

import type {ScannedCardData} from './@components/views/safe/index.js';

export const ROUTE_SCHEMA = {
  sessions: true,
  scan: true,
  safe: {
    $exact: true,
    scanCard: true,
    card: {
      $state: undefined! as {
        card: ScannedCardData;
      },
    },
  },
} satisfies SchemaRecord;

export type Router = RoutraRouter<typeof ROUTE_SCHEMA, {}>;
