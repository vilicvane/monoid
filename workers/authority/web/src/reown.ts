import {createAppKit} from '@reown/appkit';
import {EthersAdapter} from '@reown/appkit-adapter-ethers';
import {ReownAuthentication} from '@reown/appkit-controllers/features';
import {mainnet} from '@reown/appkit/networks';
import {AccountSelection, signInMethod, signInProvider} from './flow.mjs';
import {
  isSocialProvider,
  type SignInMethod,
  type SocialProvider,
} from '../../src/domain.js';

export type Identity = {
  login: string;
  method: SignInMethod;
  email?: string;
  provider?: SocialProvider;
};
type Credential = {
  token: string;
  method: SignInMethod;
  provider?: SocialProvider;
};

export function createLogin(
  projectId: string,
  onIdentity: (identity: Identity | null) => void,
  onError: () => void,
) {
  const storagePrefix = `monoid-authority-login:${projectId}`;
  const authKey = `${storagePrefix}:auth`;
  const nonceKey = `${storagePrefix}:nonce`;
  const selection = new AccountSelection();
  let verifiedCredential: Credential | null = null;
  const clearCredentials = () => {
    localStorage.removeItem(authKey);
    localStorage.removeItem(nonceKey);
    verifiedCredential = null;
  };
  // A previous page may have been suspended before its async disconnect ended.
  // New flows never restore a browser credential or reconnect a cached wallet.
  clearCredentials();
  const siwx = new ReownAuthentication({
    localAuthStorageKey: authKey,
    localNonceStorageKey: nonceKey,
  });
  const appkit = createAppKit({
    projectId,
    adapters: [new EthersAdapter()],
    networks: [mainnet],
    siwx,
    enableReconnect: false,
    metadata: {
      name: 'Monoid',
      description: 'Sign in to Monoid',
      url: location.origin,
      icons: [],
    },
    features: {
      analytics: false,
      swaps: false,
      onramp: false,
      email: true,
      socials: ['google', 'github', 'apple'],
    },
    themeMode: 'light',
    themeVariables: {
      '--w3m-accent': getComputedStyle(document.documentElement)
        .getPropertyValue('--ion-color-primary')
        .trim(),
      '--w3m-font-family': getComputedStyle(document.documentElement)
        .getPropertyValue('--ion-font-family')
        .trim(),
      '--w3m-border-radius-master': '4px',
    },
  });

  let disposed = false;
  let changingAccount = false;
  let signingOut: Promise<void> | undefined;

  const updateSelection = () => {
    const account = appkit.getAccount('eip155');
    return selection.setConnection(
      account?.isConnected ? account.caipAddress : undefined,
      signInMethod(account),
      signInProvider(account),
    );
  };

  const verify = async (): Promise<Credential | null> => {
    if (disposed || changingAccount) return null;
    updateSelection();
    const method = selection.method as SignInMethod | undefined;
    const provider = selection.provider;
    const token = localStorage.getItem(authKey);
    if (
      !selection.connection ||
      !method ||
      !token ||
      (method === 'social' && !isSocialProvider(provider))
    ) {
      verifiedCredential = null;
      onIdentity(null);
      return null;
    }
    const revision = selection.revision;
    const identity = await siwx.getSessionAccount();
    updateSelection();
    if (
      disposed ||
      !selection.accepts(revision, identity) ||
      localStorage.getItem(authKey) !== token
    )
      return null;
    if (!identity.exp || identity.exp * 1000 <= Date.now()) {
      clearCredentials();
      onIdentity(null);
      return null;
    }
    const metadata = {
      method,
      ...(isSocialProvider(provider) ? {provider} : {}),
    };
    verifiedCredential = {token, ...metadata};
    onIdentity({login: identity.address, email: identity.email, ...metadata});
    return verifiedCredential;
  };

  const sync = () => {
    void verify().catch(() => {
      if (!disposed && !changingAccount) {
        verifiedCredential = null;
        onIdentity(null);
        onError();
      }
    });
  };
  const unsubscribeSession = siwx.on('sessionChanged', sync);
  const unsubscribeAccount = appkit.subscribeAccount(account => {
    if (
      !selection.setConnection(
        account.isConnected ? account.caipAddress : undefined,
        signInMethod(account),
        signInProvider(account),
      )
    )
      return;
    verifiedCredential = null;
    onIdentity(null);
    sync();
  }, 'eip155');
  const storageChanged = (event: StorageEvent) => {
    if (event.key === authKey) {
      selection.invalidate();
      verifiedCredential = null;
      onIdentity(null);
      sync();
    }
  };
  window.addEventListener('storage', storageChanged);
  sync();

  const stop = () => {
    if (disposed) return;
    disposed = true;
    selection.stop();
    unsubscribeAccount();
    unsubscribeSession();
    window.removeEventListener('storage', storageChanged);
    void appkit.close();
  };

  return {
    open: () => appkit.open(),
    async credential() {
      const previous = verifiedCredential;
      const revision = selection.revision;
      const credential = await verify();
      // A changed account requires another explicit Continue action.
      return credential &&
        credential.token === previous?.token &&
        credential.method === previous.method &&
        credential.provider === previous.provider &&
        revision === selection.revision
        ? credential
        : null;
    },
    async changeAccount() {
      changingAccount = true;
      selection.invalidate();
      clearCredentials();
      onIdentity(null);
      try {
        await appkit.disconnect();
      } finally {
        clearCredentials();
        changingAccount = false;
      }
      if (!disposed) await appkit.open();
    },
    signOut() {
      if (signingOut) return signingOut;
      stop();
      clearCredentials();
      // A cancelled signature may still finish in the SDK. Keep erasing late
      // SIWX writes for the rest of this page's lifetime, without restoring UI.
      siwx.on('sessionChanged', clearCredentials);
      signingOut = (async () => {
        await Promise.allSettled([
          siwx.setSessions([]),
          (async () => {
            // Cancel can arrive while AppKit is still initializing adapters.
            await appkit.ready();
            await appkit.disconnect();
          })(),
        ]);
        clearCredentials();
      })();
      return signingOut;
    },
    stop,
  };
}

export type ReownLogin = ReturnType<typeof createLogin>;
