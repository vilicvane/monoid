import type {WalletKitTypes} from '@reown/walletkit';
import {buildAuthObject} from '@walletconnect/utils';
import {type ReactNode, useEffect, useRef} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../@entrances.js';
import {signEvmMessage} from '../../../@lib/monoid/index.js';
import {
  type WalletConnectAuthentication,
  type WalletConnectAuthenticationResult,
  getWalletConnectRequestExpiry,
} from '../../../@lib/wallet-connect-authentication.js';
import {
  buildWalletConnectNamespaces,
  getWalletConnectAddressType,
} from '../../../@lib/wallet-connect.js';
import type {Router} from '../../../@routes.js';
import {uint8ArrayToHex} from '../../../@utils/index.js';
import {
  assertWalletSigningAccount,
  getWalletSigningAccount,
} from '../../@monoid/get-wallet-signing-account.js';
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
    const selected = addresses
      .filter(address => getWalletConnectAddressType(address) === 'evm')
      .map(address => {
        const account = getWalletSigningAccount(
          walletStorageService.keys,
          address,
        );
        if (!account)
          throw new Error('Selected accounts are no longer in Safe.');
        return account;
      });
    const tasks = authentication.map(auth => {
      const account = selected.find(
        ({wallet}) =>
          wallet.address.toLowerCase() === auth.address.toLowerCase(),
      )!;
      return {
        auth,
        index: account.key.index,
        reference: account.reference,
        account,
      };
    });

    // Validate session capabilities before asking the user to sign anything.
    buildWalletConnectNamespaces(proposal, addresses);
    assertPending();
    const releaseSigning = walletKitService.signingLock.acquire();

    try {
      onStateChange('signing');
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
          async (applet, setStateContent, _hello, signal) => {
            const check = (): void => {
              signal.throwIfAborted();
              assertPending();
            };
            const showProgress = (): void => {
              check();
              setStateContent(
                <MonoidScanStatePromptProgress
                  current={signed.size + completed.length}
                  total={tasks.length}
                >
                  Signing
                </MonoidScanStatePromptProgress>,
              );
            };
            completed = [];
            showProgress();
            const {items} = await applet.list({});
            check();
            const indices = new Set(
              items.map(item => uint8ArrayToHex(item.index)),
            );
            const remaining = tasks.filter(
              task => !signed.has(task.auth) && indices.has(task.index),
            );
            if (!remaining.length)
              throw new Error('No selected accounts on this card');

            for (const {auth, reference, account} of remaining) {
              check();
              const signature = await signEvmMessage(
                applet,
                reference,
                auth.message,
                auth.address,
                () => {
                  check();
                  assertWalletSigningAccount(
                    walletStorageService.keys,
                    account,
                  );
                },
              );
              check();
              completed.push([
                auth,
                buildAuthObject(
                  auth.request,
                  {t: 'eip191', s: signature},
                  auth.iss,
                ),
              ]);
              showProgress();
            }
          },
        );

        assertPending();
        for (const [auth, result] of completed) signed.set(auth, result);
      }

      assertPending();
      releaseSigning();
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
      releaseSigning();
      onStateChange(undefined);
    }
  };

  return (
    <>
      <AsyncButton
        data-footer-action="sign"
        disabled={disabled}
        handler={connect}
      >
        Sign
      </AsyncButton>
      {scanPromptContent}
    </>
  );
}
