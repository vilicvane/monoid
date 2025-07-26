import type {Router as RoutraRouter, SchemaRecord} from 'routra';

export const ROUTE_SCHEMA = {
  sessions: true,
  scan: true,
  safe: {
    $exact: true,
    import: true,
  },
} satisfies SchemaRecord;

export type Router = RoutraRouter<typeof ROUTE_SCHEMA, {}>;
