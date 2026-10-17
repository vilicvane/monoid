import {Transaction, type TransactionLike, hexlify} from 'ethers';
import {reaction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {
  type AddressKind,
  getAddressKind,
  getAddressSeverity,
} from '../../@lib/address-status.js';
import {
  type EvmCalldata,
  getEvmCalldataAddresses,
} from '../../@lib/evm-calldata.js';
import type {EvmGasSettings} from '../../@lib/evm-gas-settings.js';
import {getEvmPermit} from '../../@lib/evm-permit.js';
import {getEvmPermit2} from '../../@lib/evm-permit2.js';
import {getEvmTokenAddressKind} from '../../@lib/evm-token.js';
import {formatEvmTransactionError} from '../../@lib/evm-transaction-error.js';
import {prepareEvmTransaction} from '../../@lib/prepare-evm-transaction.js';
import {getTypedDataAddresses} from '../../@lib/typed-data-fields.js';
import {
  type WalletConnectPreparedTransaction,
  parseWalletConnectRequest,
} from '../../@lib/wallet-connect-request.js';
import {
  assertWalletConnectTransaction,
  getEvmTransactionAddresses,
} from '../../@lib/wallet-connect-transaction.js';
import type {Router} from '../../@routes.js';
import {type AddressMark, getKeyWallets} from '../../@services/index.js';
import {getWalletSigningAccount} from '../@monoid/get-wallet-signing-account.js';
import {AddressDetails} from '../@ui/address-details.js';
import {AsyncButton, Button} from '../@ui/button.js';
import {ChainTag} from '../@ui/chain-name.js';
import {
  EvmTransactionReview,
  TRANSACTION_TYPE_LABELS,
} from '../@ui/evm-transaction-review.js';
import {MessageContent} from '../@ui/message-content.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  ViewPlaceholder,
} from '../@view/index.js';

import {WalletConnectMessage} from './@scan/wallet-connect-message.js';
import {WalletConnectSite} from './@scan/wallet-connect-site.js';
import {
  WalletConnectSignButton,
  type WalletConnectSigningState,
} from './@sessions/wallet-connect-sign-button.js';
import {WalletConnectTypedData} from './@sessions/wallet-connect-typed-data.js';

const TransactionTypeLabel = styled.span`
  flex-shrink: 0;
  margin-left: auto;
  color: var(--ion-color-medium-shade);
  font-size: 13px;
  white-space: nowrap;
`;

export const WalletConnectRequestView = observer(
  ({view}: RouteComponentProps<Router['sessions']['request']>): ReactNode => {
    const {
      router,
      walletKitService,
      walletStorageService,
      addressBookService,
      chainService,
      evmCalldataService,
      evmTokenService,
    } = useEntrances();

    // Keep the reviewed request and site stable through replies and transitions.
    const [request] = useState(() => {
      const pending = walletKitService.requests.get(view.id);
      return pending && structuredClone(pending);
    });
    const [session] = useState(() =>
      request ? walletKitService.sessions.get(request.topic) : undefined,
    );
    const [review] = useState(() => {
      if (!request || !session) return undefined;
      try {
        const payload = parseWalletConnectRequest(request, session);
        const addresses =
          payload.method === 'eth_signTypedData_v4'
            ? getTypedDataAddresses(payload.typedData)
            : payload.method === 'eth_sendTransaction'
              ? getEvmTransactionAddresses(payload.transaction)
              : [];
        const permit =
          payload.method === 'eth_signTypedData_v4'
            ? getEvmPermit(payload.typedData)
            : undefined;
        const permit2 =
          payload.method === 'eth_signTypedData_v4'
            ? getEvmPermit2(payload.typedData)
            : undefined;
        return {payload, addresses, permit, permit2};
      } catch (error) {
        return {error: (error as Error).message};
      }
    });
    const payload = review?.payload;
    const [transactionInput, setTransactionInput] = useState(() =>
      payload?.method === 'eth_sendTransaction'
        ? payload.transaction
        : undefined,
    );
    const [state, setState] = useState<WalletConnectSigningState>();
    const [preparation, setPreparation] = useState<{
      input: TransactionLike<string>;
      transaction: TransactionLike<string>;
      payload?: WalletConnectPreparedTransaction;
      error?: string;
    }>();
    const [preparationAttempt, setPreparationAttempt] = useState(0);
    const [dataReview, setDataReview] = useState<{
      chainId: string;
      data: EvmCalldata;
    }>();
    const [ended, setEnded] = useState(!request || !session);
    const [selectedAddress, setSelectedAddress] = useState<string>();
    const active = !view.$leaving && view.$match.$exact.$active;
    const pending = walletKitService.requests.has(view.id);
    const expiry =
      Math.min(
        request?.params.request.expiryTimestamp ?? Infinity,
        session?.expiry ?? Infinity,
      ) * 1000;
    const available = !ended;
    const retainTransaction =
      !available && payload?.method === 'eth_sendTransaction';
    const busy = state !== undefined;
    const currentPreparation =
      preparation?.input === transactionInput ? preparation : undefined;
    const signingPayload =
      payload?.method === 'eth_sendTransaction'
        ? currentPreparation?.payload
        : payload;
    const transaction = currentPreparation?.transaction ?? transactionInput;
    const transactionChainId =
      payload?.method === 'eth_sendTransaction' ? payload.chainId : undefined;
    const displayChainId =
      payload?.method === 'eth_signTypedData_v4' &&
      payload.typedData.domain.chainId !== undefined
        ? `eip155:${BigInt(payload.typedData.domain.chainId)}`
        : transactionChainId;
    const transactionTarget = transaction?.to ?? undefined;
    const transactionData =
      transaction?.data ?? (transaction ? '0x' : undefined);
    const decodedData =
      dataReview?.chainId === transactionChainId &&
      dataReview?.data.target === transactionTarget &&
      dataReview?.data.data === transactionData
        ? dataReview?.data
        : undefined;
    const addresses = [
      ...new Set([
        ...(review?.addresses ?? []),
        ...(decodedData ? getEvmCalldataAddresses(decodedData) : []),
      ]),
    ];
    const submission = walletKitService.getTransactionSubmission(view.id);
    const ownAddresses = new Set(
      walletStorageService.keys
        .flatMap(getKeyWallets)
        .filter(wallet => wallet.addressType === 'evm')
        .map(wallet => wallet.address.toLowerCase()),
    );
    const signedAddresses = new Set(
      addresses.filter(address => addressBookService.hasSigned('evm', address)),
    );
    const permitChainId = review?.permit?.chainId ?? review?.permit2?.chainId;
    const permitTokens = new Set(
      (review?.permit
        ? [review.permit.token]
        : (review?.permit2?.details.map(detail => detail.token) ?? [])
      ).map(address => address.toLowerCase()),
    );
    const addressKind = (address: string): AddressKind =>
      getEvmTokenAddressKind(
        getAddressKind(
          address,
          payload!.address,
          ownAddresses,
          signedAddresses,
        ),
        transactionChainId
          ? evmTokenService.isListed(transactionChainId, address)
          : !!permitChainId &&
              permitTokens.has(address.toLowerCase()) &&
              evmTokenService.isListed(permitChainId, address),
      );
    const addressMark = (address: string): AddressMark | undefined =>
      addressBookService.getMark('evm', address);
    const severities = addresses.map(address =>
      getAddressSeverity(addressKind(address), addressMark(address)),
    );
    const signColor = severities?.includes('danger')
      ? 'danger'
      : severities?.includes('warning')
        ? 'warning'
        : 'primary';
    const account =
      payload &&
      getWalletSigningAccount(walletStorageService.keys, payload.address);
    const nextId = Array.from(walletKitService.requests.values()).find(
      request =>
        request.id !== view.id &&
        !walletKitService.isRespondingToRequest(request.id),
    )?.id;

    useEffect(() => {
      if (!transactionChainId || transactionData === undefined || !available)
        return;
      const controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(20000),
      ]);

      void (async () => {
        const raw: EvmCalldata = {
          data: transactionData,
          target: transactionTarget,
          candidates: [],
        };
        const data =
          transactionTarget && transactionData !== '0x'
            ? await evmCalldataService
                .decode(
                  transactionChainId,
                  transactionTarget,
                  transactionData,
                  signal,
                )
                .catch(() => ({...raw, issue: 'unavailable' as const}))
            : raw;
        if (!controller.signal.aborted)
          setDataReview({chainId: transactionChainId, data});
      })();

      return () => controller.abort();
    }, [
      transactionChainId,
      transactionTarget,
      transactionData,
      available,
      evmCalldataService,
    ]);

    useEffect(() => {
      if (
        payload?.method !== 'eth_sendTransaction' ||
        !transactionInput ||
        !available
      )
        return;
      let cancelled = false;
      setPreparation(undefined);

      void (async () => {
        const saved = walletKitService.getTransactionSubmission(view.id);
        const result = saved
          ? {
              transaction: Transaction.from(saved.signedTransaction),
              unsignedTransaction: Transaction.from(saved.signedTransaction)
                .unsignedSerialized,
              error: undefined,
            }
          : await prepareEvmTransaction(
              transactionInput,
              payload.address,
              await chainService.getRPC(payload.chainId),
            );
        const {unsignedTransaction} = result;
        if (unsignedTransaction)
          assertWalletConnectTransaction(payload, unsignedTransaction);

        if (!cancelled) {
          setPreparation({
            input: transactionInput,
            transaction: result.transaction,
            error: result.error,
            payload: unsignedTransaction
              ? {
                  ...payload,
                  unsignedTransaction,
                  digest: Transaction.from(unsignedTransaction).unsignedHash,
                }
              : undefined,
          });
        }
      })().catch((error: unknown) => {
        if (!cancelled)
          setPreparation({
            input: transactionInput,
            transaction: transactionInput,
            error: formatEvmTransactionError(error),
          });
      });

      return () => {
        cancelled = true;
      };
    }, [
      payload,
      transactionInput,
      available,
      preparationAttempt,
      chainService,
      walletKitService,
      view.id,
    ]);

    const changeGas = (settings: EvmGasSettings): void => {
      setTransactionInput({...transaction!, ...settings});
    };

    useEffect(
      () =>
        reaction(
          () => walletKitService.getTransactionSubmission(view.id),
          submission => {
            if (
              submission?.broadcast &&
              !view.$leaving &&
              view.$match.$exact.$active
            ) {
              router.sessions
                .transaction({
                  id: view.id,
                  topic: submission.topic,
                  signedTransaction: submission.signedTransaction,
                })
                .$replace();
            }
          },
          {fireImmediately: true},
        ),
      [router, walletKitService, view],
    );

    const complete = async (): Promise<void> => {
      if (view.$leaving || !view.$match.$exact.$active) return;

      const next = Array.from(walletKitService.requests.values()).find(
        request =>
          request.id !== view.id &&
          !walletKitService.isRespondingToRequest(request.id),
      );
      if (next) {
        await router.sessions.request({id: next.id}).$replace().$completed;
      } else if (router.$ableToBack) {
        await router.$back().$completed;
      } else {
        await router.sessions.$replace().$completed;
      }
    };

    useEffect(() => {
      if (!active || !Number.isFinite(expiry)) return;

      const timer = setTimeout(
        () => {
          setEnded(true);
        },
        Math.max(0, expiry - Date.now()),
      );
      return () => clearTimeout(timer);
    }, [active, expiry]);

    useEffect(() => {
      if (active && !pending && state !== 'responding' && state !== 'sending') {
        setEnded(true);
      }
    }, [active, pending, state]);

    useEffect(() => {
      if (
        active &&
        !available &&
        !retainTransaction &&
        !busy &&
        nextId !== undefined
      ) {
        router.sessions.request({id: nextId}).$replace();
      }
    }, [active, available, retainTransaction, busy, router, nextId]);

    const reject = async (): Promise<void> => {
      setState('responding');
      try {
        await walletKitService.rejectRequest(view.id);
        await complete();
      } finally {
        setState(undefined);
      }
    };

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>
            {request?.params.request.method === 'eth_sendTransaction'
              ? 'Send transaction'
              : request?.params.request.method === 'eth_signTypedData_v4'
                ? 'Sign typed data'
                : 'Sign message'}
          </ViewHeaderTitle>
        </ViewHeader>
        <ViewContent
          footerReveal="end"
          footer={
            (available || retainTransaction) && (
              <>
                {retainTransaction && (
                  <Button disabled footerReveal="always">
                    {Date.now() >= expiry
                      ? 'Request expired'
                      : 'Request unavailable'}
                  </Button>
                )}
                {available &&
                  signingPayload &&
                  (active ? (
                    <WalletConnectSignButton
                      key={signingPayload.digest}
                      view={view}
                      topic={request!.topic}
                      payload={signingPayload}
                      decodedData={decodedData}
                      disabled={
                        busy ||
                        (!account && !submission) ||
                        (payload?.method === 'eth_sendTransaction' &&
                          !decodedData)
                      }
                      color={signColor}
                      onStateChange={setState}
                      onComplete={complete}
                    />
                  ) : (
                    <Button disabled loading={busy} color={signColor}>
                      {payload?.method === 'eth_sendTransaction'
                        ? 'Send'
                        : 'Sign'}
                    </Button>
                  ))}
                {available && currentPreparation?.error && (
                  <Button
                    onClick={() => {
                      setPreparation(undefined);
                      setPreparationAttempt(value => value + 1);
                    }}
                  >
                    Retry
                  </Button>
                )}
                {available && !submission && (
                  <AsyncButton
                    footerReveal="always"
                    color="neutral"
                    disabled={busy}
                    handler={reject}
                  >
                    Reject
                  </AsyncButton>
                )}
              </>
            )
          }
        >
          {session && request && (
            <WalletConnectSite
              metadata={session.peer.metadata}
              verified={request.verifyContext.verified}
              compact
            >
              {displayChainId && <ChainTag chainId={displayChainId} />}
              {transaction?.type != null && (
                <TransactionTypeLabel title="Transaction type">
                  {TRANSACTION_TYPE_LABELS[transaction.type]}
                </TransactionTypeLabel>
              )}
            </WalletConnectSite>
          )}
          {!available && !retainTransaction ? (
            <ViewPlaceholder role="status">
              Request no longer available
            </ViewPlaceholder>
          ) : payload ? (
            <>
              <WalletConnectMessage
                address={payload.address}
                accountLabel={
                  payload.method === 'eth_sendTransaction' ? 'From' : undefined
                }
              >
                {payload.method === 'eth_sendTransaction' ? (
                  transaction ? (
                    <EvmTransactionReview
                      transaction={transaction}
                      decodedData={
                        decodedData ??
                        (retainTransaction
                          ? {
                              data: transactionData!,
                              target: transactionTarget,
                              candidates: [],
                            }
                          : undefined)
                      }
                      preparing={!currentPreparation}
                      showGas={available}
                      error={available ? currentPreparation?.error : undefined}
                      onGasChange={
                        active && available && !busy && !submission
                          ? changeGas
                          : undefined
                      }
                      getAddressKind={addressKind}
                      getAddressMark={addressMark}
                      onAddressClick={setSelectedAddress}
                    />
                  ) : null
                ) : payload.method === 'eth_signTypedData_v4' ? (
                  <WalletConnectTypedData
                    data={payload.typedData}
                    permit={review?.permit}
                    permit2={review?.permit2}
                    signer={payload.address}
                    getAddressKind={addressKind}
                    getAddressMark={addressMark}
                    onAddressClick={setSelectedAddress}
                  />
                ) : (
                  <MessageContent
                    aria-label={
                      payload.text === undefined ? 'Message (hex)' : 'Message'
                    }
                  >
                    {payload.text ?? hexlify(payload.message)}
                  </MessageContent>
                )}
              </WalletConnectMessage>
            </>
          ) : (
            <ViewPlaceholder role="status">{review?.error}</ViewPlaceholder>
          )}
        </ViewContent>
        {active &&
          (available || retainTransaction) &&
          !busy &&
          selectedAddress &&
          payload && (
            <AddressDetails
              address={selectedAddress}
              kind={addressKind(selectedAddress)}
              onDismiss={() => setSelectedAddress(undefined)}
            />
          )}
      </View>
    );
  },
);
