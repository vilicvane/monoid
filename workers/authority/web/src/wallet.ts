import {createAppKit} from '@reown/appkit';
import {EthersAdapter} from '@reown/appkit-adapter-ethers';
import type {SIWXConfig, SIWXSession} from '@reown/appkit-controllers';
import {mainnet} from '@reown/appkit/networks';
import type {Account} from '../../src/domain.js';
import type {BrowserFlow} from './flow.mjs';

export function createWalletLogin(
  projectId: string,
  flow: BrowserFlow,
  onIdentity: (account: Account | null) => void,
  onError: () => void,
) {
  let sessions: SIWXSession[] = [];
  let disposed = false;
  let switching = false;
  let signingOut: Promise<void> | undefined;
  let revision = 0;
  let connection: string | undefined;
  let resetPending: Promise<unknown> = Promise.resolve();
  const pending = new Set<Promise<unknown>>();
  const request = async (path: string, input: Record<string, unknown>) => {
    const operation = flow.request(path, input);
    pending.add(operation);
    try {
      return await operation;
    } finally {
      pending.delete(operation);
    }
  };
  const reset = () => {
    sessions = [];
    revision++;
    onIdentity(null);
    resetPending = resetPending
      .catch(() => {})
      .then(() => request('reset', {flow: flow.flow}));
    return resetPending;
  };
  const siwx: SIWXConfig = {
    async createMessage(input) {
      await resetPending;
      if (disposed || switching) throw new Error('Sign-in ended');
      const current = revision;
      const result = await request('wallet/nonce', {
        flow: flow.flow,
        address: input.accountAddress,
        chainId: input.chainId,
      });
      if (disposed || switching || current !== revision)
        throw new Error('Account changed');
      return {
        ...result.data,
        toString: () => {
          if (!result.message) throw new Error('Wallet address required');
          return result.message;
        },
      };
    },
    async addSession(session) {
      const current = revision;
      if (disposed || switching) throw new Error('Sign-in ended');
      const result = await request('wallet/verify', {
        flow: flow.flow,
        message: session.message,
        signature: session.signature,
      });
      if (disposed || current !== revision) throw new Error('Account changed');
      if (
        session.data.chainId !== 'eip155:1' ||
        result.account.source !== 'wallet' ||
        (connection &&
          connection !==
            `eip155:1:${session.data.accountAddress.toLowerCase()}`) ||
        result.account.id !==
          `eip155:${session.data.accountAddress.toLowerCase()}`
      )
        throw new Error('Account changed');
      sessions = [session];
      onIdentity(result.account);
    },
    async getSessions(chainId, address) {
      return disposed
        ? []
        : sessions.filter(
            session =>
              session.data.chainId === chainId &&
              session.data.accountAddress.toLowerCase() ===
                address.toLowerCase() &&
              Date.parse(session.data.expirationTime!) > Date.now(),
          );
    },
    async revokeSession() {
      if (!disposed) await reset();
    },
    async setSessions(next) {
      if (!next.length) {
        if (!disposed) await reset();
        return;
      }
      if (next.length !== 1) throw new Error('Choose one wallet account');
      sessions = [];
      await siwx.addSession(next[0]!);
    },
    getRequired: () => true,
    signOutOnDisconnect: true,
  };
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
      email: false,
      socials: false,
      reownAuthentication: false,
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
  const unsubscribe = appkit.subscribeAccount(account => {
    const next = account.isConnected
      ? account.caipAddress?.toLowerCase()
      : undefined;
    if (next === connection) return;
    const previous = connection;
    connection = next;
    if (
      !disposed &&
      (previous ||
        (sessions.length &&
          next !==
            `eip155:1:${sessions[0]!.data.accountAddress.toLowerCase()}`))
    )
      void reset().catch(onError);
  }, 'eip155');
  const stop = () => {
    if (disposed) return;
    disposed = true;
    revision++;
    sessions = [];
    unsubscribe();
    void appkit.close();
  };
  return {
    async open() {
      await appkit.ready();
      if (disposed) return;
      // Public API: dashboard features can override local options at startup.
      appkit.updateRemoteFeatures({
        email: false,
        socials: false,
        emailCapture: false,
        reownAuthentication: false,
      });
      // Initialization may have replaced SIWX from dashboard settings. Restore
      // our verifier through the public options API before allowing connection.
      appkit.updateOptions({siwx});
      await appkit.open();
    },
    signOut() {
      if (signingOut) return signingOut;
      stop();
      signingOut = (async () => {
        await appkit.ready();
        await appkit.disconnect();
      })();
      return signingOut;
    },
    async changeAccount() {
      revision++;
      switching = true;
      sessions = [];
      try {
        await Promise.allSettled([...pending]);
        await appkit.ready();
        await appkit.disconnect();
        await resetPending;
      } finally {
        switching = false;
      }
    },
    stop,
  };
}

export type WalletLogin = ReturnType<typeof createWalletLogin>;
