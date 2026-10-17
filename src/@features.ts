export const FEATURES = [
  {
    route: 'sessions',
    name: 'Sessions',
    description: 'Manage connected apps and sites.',
  },
  {
    route: 'transactions',
    name: 'Transactions',
    description: 'View your transaction history.',
  },
] as const;

export type FeatureRoute = (typeof FEATURES)[number]['route'];
