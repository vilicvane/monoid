import {Transaction} from 'ethers';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../@entrances.js';
import type {EvmCalldata} from '../../../@lib/evm-calldata.js';
import {signEvmDigest} from '../../../@lib/monoid/index.js';
import {
  type WalletConnectPreparedTransaction,
  type WalletConnectSignRequest,
  parseWalletConnectRequest,
} from '../../../@lib/wallet-connect-request.js';
import {assertWalletConnectTransaction} from '../../../@lib/wallet-connect-transaction.js';
import type {Router} from '../../../@routes.js';
import {getWalletSigningAccount} from '../../@monoid/get-wallet-signing-account.js';
import {
  MonoidScanStatePromptProgress,
  useMonoidScanPrompt,
} from '../../@monoid/monoid-scan-prompt.js';
import {AsyncButton} from '../../@ui/button.js';

export type WalletConnectSigningState = 'signing' | 'sending' | 'responding';

export function WalletConnectSignButton({
  view,
  topic,
  payload,
  decodedData,
  disabled,
  color,
  onStateChange,
  onComplete,
}: Pick<RouteComponentProps<Router['sessions']['request']>, 'view'> & {
  topic: string;
  payload: WalletConnectSignRequest | WalletConnectPreparedTransaction;
  decodedData?: EvmCalldata;
  disabled: boolean;
  color: 'primary' | 'warning' | 'danger';
  onStateChange: (state: WalletConnectSigningState | undefined) => void;
  onComplete: () => Promise<void>;
}): ReactNode {
  const {walletKitService, walletStorageService, chainService} = useEntrances();
  const [scanPromptContent, scanPrompt] = useMonoidScanPrompt({
    auth: 'access',
    retryOnError: true,
  });
  const signature = useRef<string>(undefined);
  const [retry, setRetry] = useState(
    !!walletKitService.getTransactionSubmission(view.id),
  );
  const [state, setState] = useState<WalletConnectSigningState>();
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
        request.topic !== topic ||
        !session ||
        session.expiry * 1000 <= Date.now() ||
        (request.params.request.expiryTimestamp ?? Infinity) * 1000 <=
          Date.now()
      ) {
        throw Object.assign(new Error('Signing was cancelled.'), {
          code: 'CANCELLED',
        });
      }

      const current = parseWalletConnectRequest(request, session);
      if (
        current.address !== payload.address ||
        current.chainId !== payload.chainId ||
        current.method !== payload.method
      ) {
        throw new Error('The signing request has changed.');
      }
      if (
        current.method === 'eth_sendTransaction' &&
        payload.method === 'eth_sendTransaction'
      ) {
        assertWalletConnectTransaction(current, payload.unsignedTransaction);
      } else if ('digest' in current && current.digest !== payload.digest) {
        throw new Error('The signing request has changed.');
      }
    };

    const updateState = (state: WalletConnectSigningState): void => {
      setState(state);
      onStateChange(state);
    };

    assertPending();
    const submission = walletKitService.getTransactionSubmission(view.id);
    let result =
      signature.current ??
      (submission
        ? Transaction.from(submission.signedTransaction).signature!.serialized
        : undefined);

    try {
      if (!result) {
        const account = getWalletSigningAccount(
          walletStorageService.keys,
          payload.address,
        );
        if (!account) throw new Error('This account is no longer in Safe.');
        updateState('signing');

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
      let completed: boolean;
      if (payload.method === 'eth_sendTransaction') {
        updateState('sending');
        const provider = submission?.broadcast
          ? undefined
          : await chainService.getRPC(payload.chainId);
        assertPending();
        completed = await walletKitService.approveTransactionRequest(
          view.id,
          topic,
          payload.unsignedTransaction,
          result!,
          provider,
          decodedData,
        );
      } else {
        updateState('responding');
        completed = await walletKitService.approveRequest(view.id, result!);
      }
      if (completed) {
        if (mounted.current && !view.$leaving && view.$match.$exact.$active) {
          await onComplete();
        }
      }
    } catch (error) {
      if (result) setRetry(true);
      throw error;
    } finally {
      if (mounted.current && !view.$leaving && view.$match.$exact.$active) {
        setState(undefined);
      }
      onStateChange(undefined);
    }
  };

  return (
    <>
      <AsyncButton disabled={disabled} color={color} handler={sign}>
        {state === 'sending'
          ? 'Sending…'
          : state === 'responding'
            ? 'Responding…'
            : retry
              ? 'Retry'
              : payload.method === 'eth_sendTransaction'
                ? 'Send'
                : 'Sign'}
      </AsyncButton>
      {scanPromptContent}
    </>
  );
}
