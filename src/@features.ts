export const FEATURES = [
  {
    route: 'sessions',
    name: 'Wallet Connect',
    description: 'Manage connected apps and sites.',
  },
  {
    route: 'transactions',
    name: 'Transactions',
    description: 'View your transaction history.',
  },
] as const;

export type FeatureRoute = (typeof FEATURES)[number]['route'];
