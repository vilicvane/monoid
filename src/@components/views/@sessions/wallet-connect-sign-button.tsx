import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../@entrances.js';
import {signEvmDigest} from '../../../@lib/monoid/index.js';
import {
  type WalletConnectSignRequest,
  parseWalletConnectSignRequest,
} from '../../../@lib/wallet-connect-request.js';
import type {Router} from '../../../@routes.js';
import {getWalletSigningAccount} from '../../@monoid/get-wallet-signing-account.js';
import {
  MonoidScanStatePromptProgress,
  useMonoidScanPrompt,
} from '../../@monoid/monoid-scan-prompt.js';
import {AsyncButton} from '../../@ui/button.js';

export function WalletConnectSignButton({
  view,
  payload,
  disabled,
  color,
  onStateChange,
  onComplete,
}: Pick<RouteComponentProps<Router['sessions']['request']>, 'view'> & {
  payload: WalletConnectSignRequest;
  disabled: boolean;
  color: 'primary' | 'warning' | 'danger';
  onStateChange: (state: 'signing' | 'responding' | undefined) => void;
  onComplete: () => Promise<void>;
}): ReactNode {
  const {walletKitService, walletStorageService} = useEntrances();
  const [scanPromptContent, scanPrompt] = useMonoidScanPrompt({
    auth: 'access',
    retryOnError: true,
  });
  const signature = useRef<string>(undefined);
  const [retry, setRetry] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const sign = async (): Promise<void> => {
    const assertPending = (): void => {
      const request = walletKitService.requests.get(view.id);
      const session = request && walletKitService.sessions.get(request.topic);
      if (
        !mounted.current ||
        view.$leaving ||
        !view.$match.$exact.$active ||
        !request ||
        !session ||
        session.expiry * 1000 <= Date.now() ||
        (request.params.request.expiryTimestamp ?? Infinity) * 1000 <=
          Date.now()
      ) {
        throw Object.assign(new Error('Signing was cancelled.'), {
          code: 'CANCELLED',
        });
      }

      const current = parseWalletConnectSignRequest(request, session);
      if (
        current.address !== payload.address ||
        current.chainId !== payload.chainId ||
        current.method !== payload.method ||
        current.digest !== payload.digest
      ) {
        throw new Error('The signing request has changed.');
      }
    };

    assertPending();
    let result = signature.current;

    try {
      if (!result) {
        const account = getWalletSigningAccount(
          walletStorageService.keys,
          payload.address,
        );
        if (!account) throw new Error('This account is no longer in Safe.');
        onStateChange('signing');

        await scanPrompt('Scan card to sign', async (applet, setContent) => {
          assertPending();
          setContent(
            <MonoidScanStatePromptProgress current={1} total={1}>
              Signing
            </MonoidScanStatePromptProgress>,
          );
          result = await signEvmDigest(
            applet,
            account.reference,
            payload.digest,
            payload.address,
            assertPending,
          );
        });

        assertPending();
        signature.current = result;
      }

      assertPending();
      onStateChange('responding');
      if (await walletKitService.approveRequest(view.id, result!)) {
        if (mounted.current && !view.$leaving && view.$match.$exact.$active) {
          await onComplete();
        }
      }
    } catch (error) {
      if (signature.current) setRetry(true);
      throw error;
    } finally {
      onStateChange(undefined);
    }
  };

  return (
    <>
      <AsyncButton disabled={disabled} color={color} handler={sign}>
        {retry ? 'Retry' : 'Sign'}
      </AsyncButton>
      {scanPromptContent}
    </>
  );
}
