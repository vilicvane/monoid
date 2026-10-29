import {FeeData, Transaction} from 'ethers';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useMemo, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

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
import {getEvmTokenAddressKind} from '../../@lib/evm-token.js';
import {createEvmTransactionReplacement} from '../../@lib/evm-transaction-replacement.js';
import {signEvmDigest} from '../../@lib/monoid/index.js';
import {
  getEvmTransactionInput,
  prepareEvmTransactionReplacement,
} from '../../@lib/prepare-evm-transaction-replacement.js';
import type {EvmTransactionPreparation} from '../../@lib/prepare-evm-transaction.js';
import {getEvmTransactionAddresses} from '../../@lib/wallet-connect-transaction.js';
import type {Router} from '../../@routes.js';
import {
  type AddressMark,
  type TransactionHistoryDetail,
  getKeyWallets,
} from '../../@services/index.js';
import {useTransactionConfirmation} from '../@hooks/use-transaction-confirmation.js';
import {WalletAccountList} from '../@key/wallet-account-list.js';
import {
  assertWalletSigningAccount,
  getWalletSigningAccount,
} from '../@monoid/get-wallet-signing-account.js';
import {
  MonoidScanStatePromptProgress,
  useMonoidScanPrompt,
} from '../@monoid/monoid-scan-prompt.js';
import {AddressDetails} from '../@ui/address-details.js';
import {AsyncButton, Button} from '../@ui/button.js';
import {ChainTag} from '../@ui/chain-name.js';
import {EvmTransactionReview} from '../@ui/evm-transaction-review.js';
import {IconTagSection} from '../@ui/icon-tag.js';
import {InfoFieldset, InfoLegend} from '../@ui/info-section.js';
import {InfoMessage} from '../@ui/message-content.js';
import {
  View,
  ViewActionButton,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  ViewPlaceholder,
} from '../@view/index.js';

type ReplacementView = RouteComponentProps<
  Router['ethereum']['wallet']['transaction']['replace']
>['view'];

export const EthereumTransactionReplacementView = observer(
  ({view}: {view: ReplacementView}): ReactNode => {
    const {transactionHistoryService} = useEntrances();
    const detail = transactionHistoryService.get(
      view.address,
      view.chainId,
      view.hash,
    );
    if (!detail) {
      return (
        <View inert={!!view.$leaving}>
          <ViewHeader>
            <ViewHeaderTitle>Transaction</ViewHeaderTitle>
          </ViewHeader>
          <ViewContent>
            <ViewPlaceholder>Transaction not found.</ViewPlaceholder>
          </ViewContent>
        </View>
      );
    }
    return (
      <TransactionReplacementContent
        key={`${view.chainId}:${view.hash}:${view.kind}`}
        view={view}
        detail={detail}
      />
    );
  },
);

const TransactionReplacementContent = observer(
  function TransactionReplacementContent({
    view,
    detail,
  }: {
    view: ReplacementView;
    detail: TransactionHistoryDetail;
  }): ReactNode {
    const {
      router,
      chainService,
      transactionHistoryService,
      walletStorageService,
      evmCalldataService,
      addressBookService,
      evmTokenService,
    } = useEntrances();
    const original = useMemo(
      () => Transaction.from(detail.signedTransaction),
      [detail.signedTransaction],
    );
    const active = !view.$leaving && view.$match.$exact.$active;
    const competingData = transactionHistoryService
      .getCompetingTransactions(view.chainId, view.hash)
      .join(',');
    const competing = useMemo(
      () =>
        competingData
          ? competingData.split(',').map(raw => Transaction.from(raw))
          : [],
      [competingData],
    );
    const confirmation = useTransactionConfirmation(detail.transaction, active);
    const [settings, setSettings] = useState<EvmGasSettings>();
    const [preparation, setPreparation] = useState<{
      settings: EvmGasSettings | undefined;
      result: EvmTransactionPreparation;
    }>();
    const [attempt, setAttempt] = useState(0);
    const [busy, setBusy] = useState<'signing' | 'sending'>();
    const [decodedData, setDecodedData] = useState<EvmCalldata>();
    const [selectedAddress, setSelectedAddress] = useState<string>();
    const signature = useRef<string>(undefined);
    const [scanContent, scan] = useMonoidScanPrompt({
      auth: 'access',
      retryOnError: true,
    });
    const submission = detail.submission;
    const kind = submission?.kind ?? view.kind;
    const cancelling = kind === 'cancel';
    const minimumGas = useMemo(
      () =>
        createEvmTransactionReplacement(
          original,
          kind,
          new FeeData(null, null, null),
          competing,
        ),
      [original, kind, competing],
    );
    const initial = useMemo(
      () => getEvmTransactionInput(minimumGas),
      [minimumGas],
    );
    const saved = useMemo(
      () => submission && Transaction.from(submission.signedTransaction),
      [submission],
    );
    const prepared = saved
      ? {
          transaction: getEvmTransactionInput(saved),
          unsignedTransaction: saved.unsignedSerialized,
        }
      : preparation && preparation.settings === settings
        ? preparation.result
        : undefined;
    const transaction = prepared?.transaction ?? initial;
    const data = cancelling ? '0x' : original.data;
    const pending = confirmation.status === 'pending';
    // A saved submission might itself have consumed the nonce; first recover its hash.
    const available = !!submission || (pending && !confirmation.nonceUsed);
    const account = getWalletSigningAccount(
      walletStorageService.keys,
      original.from!,
    );
    const ownAddresses = new Set(
      walletStorageService.keys
        .flatMap(getKeyWallets)
        .filter(wallet => wallet.addressType === 'evm')
        .map(wallet => wallet.address.toLowerCase()),
    );
    const addressKind = (address: string): AddressKind =>
      getEvmTokenAddressKind(
        getAddressKind(
          address,
          original.from!,
          ownAddresses,
          new Set(
            addressBookService.hasSigned('evm', address)
              ? [address.toLowerCase()]
              : [],
          ),
        ),
        evmTokenService.isListed(view.chainId, address),
      );
    const addressMark = (address: string): AddressMark | undefined =>
      addressBookService.getMark('evm', address);
    const addresses = [
      ...getEvmTransactionAddresses(transaction),
      ...(decodedData ? getEvmCalldataAddresses(decodedData) : []),
    ];
    const severities = addresses.map(address =>
      getAddressSeverity(addressKind(address), addressMark(address)),
    );
    const color =
      cancelling || severities.includes('danger')
        ? 'danger'
        : severities.includes('warning')
          ? 'warning'
          : 'primary';

    useEffect(() => {
      if (submission || !available) return;
      let cancelled = false;
      setPreparation(undefined);
      void chainService
        .getRPC(view.chainId)
        .then(provider =>
          prepareEvmTransactionReplacement(
            original,
            kind,
            provider,
            settings,
            competing,
          ),
        )
        .catch(
          (error: unknown): EvmTransactionPreparation => ({
            transaction: {...initial, ...settings},
            error: (error as Error).message,
          }),
        )
        .then(result => {
          if (!cancelled) setPreparation({settings, result});
        });
      return () => {
        cancelled = true;
      };
    }, [
      chainService,
      view.chainId,
      original,
      kind,
      settings,
      attempt,
      submission,
      available,
      initial,
      competing,
    ]);

    useEffect(() => {
      const controller = new AbortController();
      const raw: EvmCalldata = {
        data,
        target: original.to ?? undefined,
        candidates: [],
      };
      void (
        data === '0x' || !original.to
          ? Promise.resolve(raw)
          : evmCalldataService
              .decode(
                view.chainId,
                original.to,
                data,
                AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(20000),
                ]),
              )
              .catch(() => ({...raw, issue: 'unavailable' as const}))
      ).then(decoded => {
        if (!controller.signal.aborted) setDecodedData(decoded);
      });
      return () => controller.abort();
    }, [evmCalldataService, view.chainId, original, data]);

    const openTransaction = (hash: string): void => {
      router.ethereum
        .wallet({address: original.from!})
        .transaction({chainId: view.chainId, hash})
        .$replace();
    };
    const assertActive = (): void => {
      if (view.$leaving || !view.$match.$exact.$active) {
        throw Object.assign(new Error('Signing was cancelled.'), {
          code: 'CANCELLED',
        });
      }
      const current = transactionHistoryService.get(
        view.address,
        view.chainId,
        view.hash,
      );
      if (!current?.submission && current?.transaction.status !== 'pending')
        throw Object.assign(
          new Error('This transaction is no longer pending.'),
          {code: 'CANCELLED'},
        );
    };
    const submit = async (): Promise<void> => {
      assertActive();
      const unsigned = prepared?.unsignedTransaction;
      if (!unsigned || !account) return;
      try {
        let result = saved?.signature?.serialized ?? signature.current;
        if (!result) {
          setBusy('signing');
          await scan(
            'Scan card to sign',
            async (applet, setContent, _hello, signal) => {
              const check = (): void => {
                signal.throwIfAborted();
                assertActive();
              };
              check();
              setContent(
                <MonoidScanStatePromptProgress current={0} total={1}>
                  Signing
                </MonoidScanStatePromptProgress>,
              );
              result = await signEvmDigest(
                applet,
                account.reference,
                Transaction.from(unsigned).unsignedHash,
                original.from!,
                () => {
                  check();
                  assertWalletSigningAccount(
                    walletStorageService.keys,
                    account,
                  );
                },
              );
              check();
              setContent(
                <MonoidScanStatePromptProgress current={1} total={1}>
                  Signing
                </MonoidScanStatePromptProgress>,
              );
            },
          );
          assertActive();
          signature.current = result;
        }
        setBusy('sending');
        const provider = await chainService.getRPC(view.chainId);
        assertActive();
        const replacement = await transactionHistoryService.submitReplacement(
          view.chainId,
          view.hash,
          kind,
          unsigned,
          result!,
          provider,
        );
        if (!view.$leaving && view.$match.$exact.$active)
          openTransaction(replacement.transaction.hash);
      } catch (error) {
        if (
          !transactionHistoryService.get(view.address, view.chainId, view.hash)
            ?.submission
        )
          signature.current = undefined;
        throw error;
      } finally {
        setBusy(undefined);
      }
    };

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>
            {cancelling ? 'Cancel transaction' : 'Speed up'}
          </ViewHeaderTitle>
        </ViewHeader>
        <ViewContent
          footerReveal="end"
          footer={
            !available ? (
              <Button
                color="neutral"
                onClick={() => openTransaction(view.hash)}
              >
                View transaction
              </Button>
            ) : (
              <>
                <AsyncButton
                  color={color}
                  disabled={
                    !!busy ||
                    !account ||
                    !prepared?.unsignedTransaction ||
                    !decodedData
                  }
                  handler={submit}
                >
                  {busy === 'signing'
                    ? 'Signing…'
                    : busy === 'sending'
                      ? 'Sending…'
                      : submission || signature.current
                        ? 'Retry'
                        : cancelling
                          ? 'Cancel transaction'
                          : 'Speed up'}
                </AsyncButton>
                <ViewActionButton
                  visible={!!prepared?.error}
                  color="neutral"
                  footerReveal="always"
                  onClick={() => {
                    signature.current = undefined;
                    setAttempt(value => value + 1);
                  }}
                >
                  Refresh
                </ViewActionButton>
              </>
            )
          }
        >
          <IconTagSection>
            <ChainTag chainId={view.chainId} />
          </IconTagSection>
          <InfoMessage>
            {!available
              ? pending
                ? 'This nonce has already been used. Waiting for the transaction result.'
                : 'This transaction is no longer pending.'
              : submission
                ? 'Retry submits the same signed transaction.'
                : cancelling
                  ? 'Send a zero-value transaction to yourself with the same nonce. The original may still confirm first. A network fee applies.'
                  : 'Keep the same transaction and increase its network fee.'}
          </InfoMessage>
          <InfoFieldset>
            <InfoLegend>From</InfoLegend>
            <WalletAccountList
              keys={walletStorageService.keys}
              addressType="evm"
              addresses={[original.from!]}
              compact
              compactContent
              contained
            />
          </InfoFieldset>
          <EvmTransactionReview
            minimumGas={minimumGas}
            transaction={transaction}
            decodedData={decodedData}
            preparing={!prepared && available}
            error={prepared?.error}
            onGasChange={
              !busy && !submission && available
                ? value => {
                    signature.current = undefined;
                    setSettings(value);
                  }
                : undefined
            }
            getAddressKind={addressKind}
            getAddressMark={addressMark}
            onAddressClick={setSelectedAddress}
          />
        </ViewContent>
        {selectedAddress && active && (
          <AddressDetails
            address={selectedAddress}
            kind={addressKind(selectedAddress)}
            onDismiss={() => setSelectedAddress(undefined)}
          />
        )}
        {scanContent}
      </View>
    );
  },
);
