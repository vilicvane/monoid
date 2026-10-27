export interface Account {
  id: string;
  login: string;
}

export type SignInMethod = 'wallet' | 'email' | 'social';

// AppKit 1.8.24: @reown/appkit-common SocialProvider.
export const SOCIAL_PROVIDERS = [
  'google',
  'github',
  'apple',
  'facebook',
  'x',
  'discord',
  'farcaster',
] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];
export const isSocialProvider = (value: unknown): value is SocialProvider =>
  (SOCIAL_PROVIDERS as readonly unknown[]).includes(value);

export interface SignedInAccount extends Account {
  method: SignInMethod;
  email?: string;
  provider?: SocialProvider;
}

export interface Group {
  name: string;
  allowPeerExtension: boolean;
  createdAt: number;
}

export interface Owner {
  source: 'reown' | 'wallet' | 'github-user' | 'github-organization';
  id: string;
}

export interface Namespace extends Owner {
  displayName: string;
}

export interface Session {
  account: SignedInAccount;
  wallet?: Account;
  reownToken: string;
  absoluteExpiresAt: number;
  github?: {account: Account; token: string};
}
