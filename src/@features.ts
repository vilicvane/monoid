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
  {
    route: 'bitcoin',
    name: 'Bitcoin',
    description: 'Send and receive BTC.',
  },
] as const;

export type FeatureRoute = (typeof FEATURES)[number]['route'];
