import {createAppKit} from '@reown/appkit';
import {EthersAdapter} from '@reown/appkit-adapter-ethers';
import {ReownAuthentication} from '@reown/appkit-controllers/features';
import {mainnet} from '@reown/appkit/networks';
import {AccountSelection} from './flow.mjs';

export type Identity = {email?: string};

export function createLogin(
  projectId: string,
  onIdentity: (identity: Identity | null) => void,
  onError: () => void,
) {
  const storagePrefix = `monoid-authority-login:${projectId}`;
  const authKey = `${storagePrefix}:auth`;
  const nonceKey = `${storagePrefix}:nonce`;
  const selection = new AccountSelection();
  const siwx = new ReownAuthentication({
    localAuthStorageKey: authKey,
    localNonceStorageKey: nonceKey,
  });
  const appkit = createAppKit({
    projectId,
    adapters: [new EthersAdapter()],
    networks: [mainnet],
    siwx,
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
      '--w3m-accent': '#3377ff',
      '--w3m-font-family': getComputedStyle(document.documentElement)
        .getPropertyValue('--ion-font-family')
        .trim(),
      '--w3m-border-radius-master': '4px',
    },
  });

  let disposed = false;
  let changingAccount = false;
  let verifiedToken: string | null = null;

  const clearCredentials = () => {
    localStorage.removeItem(authKey);
    localStorage.removeItem(nonceKey);
    verifiedToken = null;
  };

  const verify = async (): Promise<string | null> => {
    if (disposed || changingAccount) return null;
    const account = appkit.getAccount('eip155');
    selection.setConnection(
      account?.isConnected ? account.caipAddress : undefined,
    );
    const token = localStorage.getItem(authKey);
    if (!selection.connection || !token) {
      verifiedToken = null;
      onIdentity(null);
      return null;
    }
    const revision = selection.revision;
    const identity = await siwx.getSessionAccount();
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
    verifiedToken = token;
    onIdentity({email: identity.email});
    return token;
  };

  const sync = () => {
    void verify().catch(() => {
      if (!disposed && !changingAccount) {
        verifiedToken = null;
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
      )
    )
      return;
    verifiedToken = null;
    onIdentity(null);
    sync();
  }, 'eip155');
  const storageChanged = (event: StorageEvent) => {
    if (event.key === authKey) {
      selection.invalidate();
      verifiedToken = null;
      onIdentity(null);
      sync();
    }
  };
  window.addEventListener('storage', storageChanged);
  sync();

  return {
    open: () => appkit.open(),
    async credential() {
      const previous = verifiedToken;
      const token = await verify();
      // A changed account requires another explicit Continue action.
      return token && token === previous ? token : null;
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
    stop() {
      disposed = true;
      selection.stop();
      unsubscribeAccount();
      unsubscribeSession();
      window.removeEventListener('storage', storageChanged);
      void appkit.close();
    },
  };
}

export type ReownLogin = ReturnType<typeof createLogin>;
