import {Transaction, hexlify} from 'ethers';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../@entrances.js';
import type {EvmCalldata} from '../../../@lib/evm-calldata.js';
import {
  MonoidCardError,
  signEvmDigest,
  signSolanaMessage,
} from '../../../@lib/monoid/index.js';
import {createSolanaRPC} from '../../../@lib/solana-rpc.js';
import {
  type WalletConnectPreparedTransaction,
  type WalletConnectSignRequest,
  type WalletConnectSolanaTransactionRequest,
  parseWalletConnectRequest,
} from '../../../@lib/wallet-connect-request.js';
import {assertWalletConnectTransaction} from '../../../@lib/wallet-connect-transaction.js';
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

export type WalletConnectSigningState = 'signing' | 'sending' | 'responding';

export function WalletConnectSignButton({
  view,
  topic,
  payload,
  selectedAddresses = [],
  decodedData,
  disabled,
  color,
  onStateChange,
  onComplete,
}: Pick<RouteComponentProps<Router['sessions']['request']>, 'view'> & {
  topic: string;
  payload:
    | WalletConnectSignRequest
    | WalletConnectPreparedTransaction
    | WalletConnectSolanaTransactionRequest;
  selectedAddresses?: readonly (string | undefined)[];
  decodedData?: EvmCalldata;
  disabled: boolean;
  color: 'primary' | 'warning' | 'danger';
  onStateChange: (state: WalletConnectSigningState | undefined) => void;
  onComplete: () => Promise<void>;
}): ReactNode {
  const {walletKit, walletKitService, walletStorageService, chainService} =
    useEntrances();
  const [scanPromptContent, scanPrompt] = useMonoidScanPrompt({
    auth: 'access',
    retryOnError: true,
  });
  const signature = useRef<string>(undefined);
  const transactionSignatures = useRef<{address: string; signature: string}[]>(
    [],
  );
  const [retry, setRetry] = useState(
    !!walletKitService.getTransactionSubmission(view.id) ||
      !!walletKitService.getSolanaTransactionSubmission(view.id),
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
        current.chainId !== payload.chainId ||
        current.method !== payload.method
      ) {
        throw new Error('The signing request has changed.');
      }
      if ('transactions' in payload) {
        if (
          !('transactions' in current) ||
          (current.method === 'solana_signAndSendTransaction' &&
            payload.method === 'solana_signAndSendTransaction' &&
            JSON.stringify(current.sendOptions) !==
              JSON.stringify(payload.sendOptions)) ||
          current.transactions.length !== payload.transactions.length ||
          selectedAddresses.length !== payload.transactions.length ||
          current.transactions.some(
            (item, index) =>
              !selectedAddresses[index] ||
              !item.addresses.includes(selectedAddresses[index]!) ||
              hexlify(item.transaction.bytes) !==
                hexlify(payload.transactions[index].transaction.bytes),
          )
        ) {
          throw new Error('The signing request has changed.');
        }
        return;
      }
      if (!('address' in current) || current.address !== payload.address) {
        throw new Error('The signing request has changed.');
      }
      if (
        current.method === 'eth_sendTransaction' &&
        payload.method === 'eth_sendTransaction'
      ) {
        assertWalletConnectTransaction(current, payload.unsignedTransaction);
      } else if (
        current.method === 'solana_signMessage' &&
        payload.method === 'solana_signMessage' &&
        hexlify(current.message) !== hexlify(payload.message)
      ) {
        throw new Error('The signing request has changed.');
      } else if (
        'digest' in current &&
        'digest' in payload &&
        current.digest !== payload.digest
      ) {
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

    const releaseSigning = walletKitService.signingLock.acquire();
    try {
      if ('transactions' in payload) {
        const submission = walletKitService.getSolanaTransactionSubmission(
          view.id,
        );
        const sending = payload.method === 'solana_signAndSendTransaction';
        const signed = transactionSignatures.current;
        while (
          !submission &&
          signed.filter(Boolean).length < payload.transactions.length
        ) {
          assertPending();
          updateState('signing');
          await scanPrompt(
            signed.some(Boolean)
              ? 'Scan next card to sign'
              : 'Scan card to sign',
            async (applet, setContent, _hello, signal) => {
              const check = (): void => {
                signal.throwIfAborted();
                assertPending();
              };
              const showProgress = (): void => {
                check();
                setContent(
                  <MonoidScanStatePromptProgress
                    current={signed.filter(Boolean).length}
                    total={payload.transactions.length}
                  >
                    Signing
                  </MonoidScanStatePromptProgress>,
                );
              };
              showProgress();
              const {items} = await applet.list({});
              check();
              const indices = new Set(
                items.map(item => uint8ArrayToHex(item.index)),
              );
              const remaining = payload.transactions.flatMap(
                ({transaction}, index) => {
                  if (signed[index]) return [];
                  const address = selectedAddresses[index]!;
                  const account = getWalletSigningAccount(
                    walletStorageService.keys,
                    address,
                    'solana',
                  );
                  if (!account)
                    throw new Error('This account is no longer in Safe.');
                  return indices.has(account.key.index)
                    ? [{transaction, index, address, account}]
                    : [];
                },
              );
              if (!remaining.length)
                throw new MonoidCardError('Account not on this card');
              for (const {transaction, index, address, account} of remaining) {
                check();
                const signature = await signSolanaMessage(
                  applet,
                  account.reference,
                  transaction.messageBytes,
                  address,
                  () => {
                    check();
                    assertWalletSigningAccount(
                      walletStorageService.keys,
                      account,
                    );
                  },
                );
                check();
                signed[index] = {address, signature};
                showProgress();
              }
            },
          );
        }
        assertPending();
        updateState(
          sending && !submission?.broadcast ? 'sending' : 'responding',
        );
        const rpc =
          sending && !submission?.broadcast
            ? createSolanaRPC(payload.chainId, walletKit.core.projectId!)
            : undefined;
        const completed = submission
          ? await walletKitService.resumeSolanaTransactionRequest(
              view.id,
              topic,
              rpc,
            )
          : await walletKitService.approveSolanaTransactionRequest(
              view.id,
              topic,
              payload,
              signed,
              rpc,
            );
        if (
          completed &&
          !sending &&
          mounted.current &&
          !view.$leaving &&
          view.$match.$exact.$active
        ) {
          await onComplete();
        }
        return;
      }
      if (!result) {
        const account = getWalletSigningAccount(
          walletStorageService.keys,
          payload.address,
          payload.method === 'solana_signMessage' ? 'solana' : 'evm',
        );
        if (!account) throw new Error('This account is no longer in Safe.');
        updateState('signing');

        await scanPrompt(
          'Scan card to sign',
          async (applet, setContent, _hello, signal) => {
            const check = (): void => {
              signal.throwIfAborted();
              assertPending();
            };
            check();
            setContent(
              <MonoidScanStatePromptProgress current={0} total={1}>
                Signing
              </MonoidScanStatePromptProgress>,
            );
            if (payload.method === 'solana_signMessage') {
              const currentAccount = getWalletSigningAccount(
                walletStorageService.keys,
                payload.address,
                'solana',
              );
              if (!currentAccount)
                throw new Error('This account is no longer in Safe.');
              result = await signSolanaMessage(
                applet,
                currentAccount.reference,
                payload.message,
                payload.address,
                () => {
                  check();
                  assertWalletSigningAccount(
                    walletStorageService.keys,
                    currentAccount,
                  );
                },
              );
            } else {
              const currentAccount = getWalletSigningAccount(
                walletStorageService.keys,
                payload.address,
              );
              if (!currentAccount)
                throw new Error('This account is no longer in Safe.');
              result = await signEvmDigest(
                applet,
                currentAccount.reference,
                payload.digest,
                payload.address,
                () => {
                  check();
                  assertWalletSigningAccount(
                    walletStorageService.keys,
                    currentAccount,
                  );
                },
              );
            }
            check();
            setContent(
              <MonoidScanStatePromptProgress current={1} total={1}>
                Signing
              </MonoidScanStatePromptProgress>,
            );
          },
        );

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
      // Response recovery for a broadcast transaction belongs to its result page.
      if (walletKitService.getTransactionSubmission(view.id)?.broadcast) return;
      if (walletKitService.getSolanaTransactionSubmission(view.id)?.broadcast)
        return;
      if (
        result ||
        transactionSignatures.current.some(Boolean) ||
        walletKitService.getSolanaTransactionSubmission(view.id)
      )
        setRetry(true);
      throw error;
    } finally {
      releaseSigning();
      if (mounted.current && !view.$leaving && view.$match.$exact.$active) {
        setState(undefined);
      }
      onStateChange(undefined);
    }
  };

  return (
    <>
      <AsyncButton
        data-footer-action="sign"
        disabled={disabled}
        color={color}
        handler={sign}
      >
        {state === 'sending'
          ? 'Sending…'
          : state === 'responding'
            ? 'Responding…'
            : retry
              ? 'Retry'
              : payload.method === 'eth_sendTransaction' ||
                  payload.method === 'solana_signAndSendTransaction'
                ? 'Send'
                : 'Sign'}
      </AsyncButton>
      {scanPromptContent}
    </>
  );
}
