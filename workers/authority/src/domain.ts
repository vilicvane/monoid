export interface Owner {
  source: 'google' | 'github-user' | 'github-organization' | 'wallet';
  id: string;
}

export interface Namespace extends Owner {
  displayName: string;
}

export interface Account extends Namespace {
  source: 'google' | 'github-user' | 'wallet';
}

export interface Group {
  name: string;
  allowPeerExtension: boolean;
  createdAt: number;
}

export interface Session {
  account: Account;
  absoluteExpiresAt: number;
  githubToken?: string;
}
