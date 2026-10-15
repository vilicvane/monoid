import type {WalletKitTypes} from '@reown/walletkit';
import {buildAuthObject} from '@walletconnect/utils';
import {type ReactNode, useEffect, useRef} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {BIP39Seed} from '../../../@atomics.js';
import {useEntrances} from '../../../@entrances.js';
import {parseDerivationPath} from '../../../@lib/bip39.js';
import {signEvmMessage} from '../../../@lib/monoid/index.js';
import {
  type WalletConnectAuthentication,
  type WalletConnectAuthenticationResult,
  getWalletConnectRequestExpiry,
} from '../../../@lib/wallet-connect-authentication.js';
import {buildWalletConnectNamespaces} from '../../../@lib/wallet-connect.js';
import type {Router} from '../../../@routes.js';
import {getKeyWallets} from '../../../@services/index.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../../@utils/index.js';
import {
  MonoidScanStatePromptProgress,
  useMonoidScanPrompt,
} from '../../@monoid/monoid-scan-prompt.js';
import {AsyncButton} from '../../@ui/button.js';

export function WalletConnectApproveButton({
  view,
  proposal,
  disabled,
  onStateChange,
}: Pick<
  RouteComponentProps<Router['scan']['connection']['authentication']>,
  'view'
> & {
  proposal: WalletKitTypes.SessionProposal;
  disabled: boolean;
  onStateChange: (state: 'signing' | 'connecting' | undefined) => void;
}): ReactNode {
  const {router, walletKitService, walletStorageService} = useEntrances();
  const [scanPromptContent, scanPrompt] = useMonoidScanPrompt({
    auth: 'access',
    retryOnError: true,
  });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const connect = async (): Promise<void> => {
    const {addresses, authentication} = view;
    const assertPending = (): void => {
      if (
        !mounted.current ||
        view.$leaving ||
        !view.$match.$exact.$active ||
        !walletKitService.proposals.has(view.id) ||
        getWalletConnectRequestExpiry(proposal) <= Date.now()
      ) {
        throw Object.assign(new Error('Sign-in was cancelled.'), {
          code: 'CANCELLED',
        });
      }
    };
    const wallets = walletStorageService.keys.flatMap(key =>
      getKeyWallets(key)
        .filter(wallet => wallet.addressType === 'evm')
        .map(wallet => ({key, wallet})),
    );
    const selected = addresses.map(address => {
      const account = wallets.find(
        ({wallet}) => wallet.address.toLowerCase() === address.toLowerCase(),
      );
      if (!account) throw new Error('Selected accounts are no longer in Safe.');
      return account;
    });
    const tasks = authentication.map(auth => {
      const {key, wallet} = selected.find(
        ({wallet}) =>
          wallet.address.toLowerCase() === auth.address.toLowerCase(),
      )!;
      return {
        auth,
        index: key.index,
        reference: {
          index: hexToUint8Array(key.index),
          ...(wallet.seed !== undefined && {
            seed: BIP39Seed.satisfies(wallet.seed),
          }),
          ...(wallet.path !== undefined && {
            curve: wallet.curve!,
            path: parseDerivationPath(wallet.path),
          }),
        },
      };
    });

    // Validate session capabilities before asking the user to sign anything.
    buildWalletConnectNamespaces(proposal, addresses);
    assertPending();
    onStateChange('signing');

    try {
      const signed = new Map<
        WalletConnectAuthentication,
        WalletConnectAuthenticationResult
      >();

      while (signed.size < tasks.length) {
        assertPending();
        let completed: [
          WalletConnectAuthentication,
          WalletConnectAuthenticationResult,
        ][] = [];

        await scanPrompt(
          signed.size ? 'Scan next card to sign in' : 'Scan card to sign in',
          async (applet, setStateContent) => {
            assertPending();
            const {items} = await applet.list({});
            const indices = new Set(
              items.map(item => uint8ArrayToHex(item.index)),
            );
            const remaining = tasks.filter(
              task => !signed.has(task.auth) && indices.has(task.index),
            );
            if (!remaining.length)
              throw new Error('No selected accounts on this card.');
            completed = [];

            for (const {auth, reference} of remaining) {
              assertPending();
              setStateContent(
                <MonoidScanStatePromptProgress
                  current={signed.size + completed.length + 1}
                  total={tasks.length}
                >
                  Signing
                </MonoidScanStatePromptProgress>,
              );
              const signature = await signEvmMessage(
                applet,
                reference,
                auth.message,
                auth.address,
              );
              assertPending();
              completed.push([
                auth,
                buildAuthObject(
                  auth.request,
                  {t: 'eip191', s: signature},
                  auth.iss,
                ),
              ]);
            }
          },
        );

        assertPending();
        for (const [auth, result] of completed) signed.set(auth, result);
      }

      assertPending();
      onStateChange('connecting');
      const session = await walletKitService.approve(
        view.id,
        addresses,
        authentication.map(auth => signed.get(auth)!),
      );

      if (
        session &&
        mounted.current &&
        !view.$leaving &&
        view.$match.$exact.$active
      ) {
        router.sessions.$reset();
      }
    } finally {
      onStateChange(undefined);
    }
  };

  return (
    <>
      <AsyncButton disabled={disabled} handler={connect}>
        Sign
      </AsyncButton>
      {scanPromptContent}
    </>
  );
}
