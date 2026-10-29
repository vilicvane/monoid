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
  {
    route: 'securityKey',
    name: 'Security Key',
    description: 'Manage credentials on your card.',
  },
  {
    route: 'otp',
    name: 'One-time Password',
    description: 'Get verification codes from your card.',
  },
  {
    route: 'cardApplets',
    name: 'Card Applets',
    description: 'Manage card applets.',
  },
] as const;

export type FeatureRoute = (typeof FEATURES)[number]['route'];
