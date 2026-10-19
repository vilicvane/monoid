export const FEATURES = [
  {
    route: 'sessions',
    name: 'Wallet Connect',
    description: 'Manage connected apps and sites.',
  },
  {
    route: 'bitcoin',
    name: 'Bitcoin',
    description: 'Send and receive BTC.',
  },
  {
    route: 'ethereum',
    name: 'Ethereum',
    description: 'View your EVM transaction history.',
  },
  {
    route: 'solana',
    name: 'Solana',
    description: 'View your Solana transaction history.',
  },
] as const;

export type FeatureRoute = (typeof FEATURES)[number]['route'];
