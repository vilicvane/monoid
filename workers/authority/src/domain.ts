export interface Account {
  id: string;
  login: string;
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
  account: Account;
  wallet?: Account;
  reownToken: string;
  expiresAt: number;
  github?: {account: Account; token: string};
}
