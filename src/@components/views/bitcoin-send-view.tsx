import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import type {BitcoinFeeRates} from '../../@lib/bitcoin-api.js';
import {
  type BitcoinTransactionPreview,
  formatBitcoinAmount,
  parseBitcoinAmount,
  prepareBitcoinTransaction,
  validateBitcoinAddress,
  verifyBitcoinInputs,
} from '../../@lib/bitcoin-transaction.js';
import {getBitcoinWalletSigningAccount} from '../../@lib/bitcoin-wallet.js';
import {
  type SignedBitcoinTransaction,
  signBitcoinTransaction,
} from '../../@lib/monoid/index.js';
import type {Router} from '../../@routes.js';
import {WalletAccountFieldset} from '../@key/wallet-account-fieldset.js';
import {
  MonoidScanStatePromptProgress,
  useMonoidScanPrompt,
} from '../@monoid/monoid-scan-prompt.js';
import {Button} from '../@ui/button.js';
import {
  InfoFieldset,
  InfoFieldsetValue,
  InfoLegend,
  InfoSection,
  InfoSectionItemLabel,
  InfoSectionRow,
  InfoTable,
} from '../@ui/info-section.js';
import {Input} from '../@ui/input.js';
import {InteractiveAddress} from '../@ui/interactive-address.js';
import {
  ErrorMessage,
  InfoMessage,
  WarningMessage,
} from '../@ui/message-content.js';
import {SegmentedControl} from '../@ui/segmented-control.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../@view/index.js';

type FeeChoice = keyof BitcoinFeeRates | 'custom';

export const BitcoinSendView = observer(
  ({
    view,
  }: RouteComponentProps<Router['bitcoin']['wallet']['send']>): ReactNode => {
    const {router, walletStorageService, bitcoinWalletService} = useEntrances();
    const active = !view.$leaving && view.$match.$exact.$active;
    const account = getBitcoinWalletSigningAccount(
      walletStorageService.keys,
      view.address,
    );
    const [recipient, setRecipient] = useState('');
    const [amount, setAmount] = useState('');
    const [maximum, setMaximum] = useState(false);
    const [fees, setFees] = useState<BitcoinFeeRates>();
    const [feeError, setFeeError] = useState<string>();
    const [feeChoice, setFeeChoice] = useState<FeeChoice>('normal');
    const [customFee, setCustomFee] = useState('1');
    const [preview, setPreview] = useState<BitcoinTransactionPreview>();
    const [busy, setBusy] = useState<'preparing' | 'signing' | 'sending'>();
    const [error, setError] = useState<string>();
    const operation = useRef<AbortController | undefined>(undefined);
    const mounted = useRef(true);
    const currentActive = useRef(active);
    currentActive.current = active;
    const [scanContent, scan] = useMonoidScanPrompt({
      auth: 'access',
      retryOnError: true,
    });
    const feeRate =
      feeChoice === 'custom' ? Number(customFee) : fees?.[feeChoice];

    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        operation.current?.abort();
      };
    }, []);

    useEffect(() => {
      if (!active) {
        operation.current?.abort();
        return;
      }
      const controller = new AbortController();
      void bitcoinWalletService.api.getFeeRates(controller.signal).then(
        value => {
          if (!controller.signal.aborted) {
            setFees(value);
            setFeeError(undefined);
          }
        },
        () => {
          if (!controller.signal.aborted)
            setFeeError(
              'Fee estimates are unavailable. Enter a custom fee rate to continue.',
            );
        },
      );
      return () => controller.abort();
    }, [active, bitcoinWalletService]);

    const assertActive = (signal?: AbortSignal): void => {
      signal?.throwIfAborted();
      const current = getBitcoinWalletSigningAccount(
        walletStorageService.keys,
        view.address,
      );
      if (
        !mounted.current ||
        !currentActive.current ||
        !current ||
        !account ||
        current.key.index !== account.key.index ||
        current.wallet.publicKey !== account.wallet.publicKey ||
        current.wallet.path !== account.wallet.path
      ) {
        throw Object.assign(
          new Error('The selected wallet is no longer available.'),
          {code: 'CANCELLED'},
        );
      }
    };

    const review = async (): Promise<void> => {
      if (operation.current || !account) return;
      const controller = new AbortController();
      operation.current = controller;
      setBusy('preparing');
      setError(undefined);
      try {
        assertActive(controller.signal);
        const destination = validateBitcoinAddress(recipient);
        const value = maximum ? 'max' : parseBitcoinAmount(amount);
        if (!feeRate || !Number.isFinite(feeRate) || feeRate < 1)
          throw new Error('Enter a fee rate of at least 1 sat/vB.');
        await bitcoinWalletService.refresh(view.address);
        assertActive(controller.signal);
        const state = bitcoinWalletService.get(view.address);
        if (state.status !== 'ready' || !state.snapshot)
          throw new Error(
            state.error ??
              'Could not refresh the available balance. Please try again.',
          );
        const next = prepareBitcoinTransaction({
          address: view.address,
          addressType: account.wallet.addressType,
          recipient: destination,
          amountSats: value,
          feeRate,
          utxos: state.snapshot.utxos,
        });
        const parents = await bitcoinWalletService.api.getPreviousTransactions(
          next.inputs,
          controller.signal,
        );
        assertActive(controller.signal);
        verifyBitcoinInputs(next, parents);
        setPreview(next);
      } catch (cause) {
        if (mounted.current && !controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not prepare the transaction.',
          );
      } finally {
        operation.current = undefined;
        if (mounted.current) setBusy(undefined);
      }
    };

    const submit = async (): Promise<void> => {
      if (operation.current || !account || !preview) return;
      const controller = new AbortController();
      operation.current = controller;
      setBusy('signing');
      setError(undefined);
      try {
        assertActive(controller.signal);
        await bitcoinWalletService.refresh(view.address);
        assertActive(controller.signal);
        const state = bitcoinWalletService.get(view.address);
        if (state.status !== 'ready' || !state.snapshot)
          throw new Error(
            state.error ?? 'Could not check the available balance.',
          );
        if (
          !preview.inputs.every(input =>
            state.snapshot!.utxos.some(
              utxo =>
                utxo.txid === input.txid &&
                utxo.vout === input.vout &&
                utxo.value === input.value,
            ),
          )
        ) {
          setPreview(undefined);
          throw new Error(
            'The available balance has changed. Review the payment again.',
          );
        }
        let signed: SignedBitcoinTransaction | undefined;
        await scan(
          'Scan card to sign',
          async (applet, setContent, _hello, signal) => {
            const check = (): void => {
              signal.throwIfAborted();
              assertActive(controller.signal);
            };
            check();
            setContent(
              <MonoidScanStatePromptProgress current={1} total={1}>
                Signing
              </MonoidScanStatePromptProgress>,
            );
            signed = await signBitcoinTransaction(
              applet,
              account.reference,
              preview,
              check,
            );
          },
        );
        assertActive(controller.signal);
        if (!signed) return;
        setBusy('sending');
        try {
          await bitcoinWalletService.broadcast(
            view.address,
            {
              txid: signed.txid,
              hex: signed.hex,
              inputOutpoints: preview.inputs.map(
                input => `${input.txid}:${input.vout}`,
              ),
              payment: {
                recipient: preview.recipient,
                amountSats: preview.amountSats.toString(),
                feeSats: preview.feeSats.toString(),
              },
            },
            controller.signal,
          );
        } finally {
          // The durable record also covers a lost broadcast response. Its detail
          // page retries these exact bytes instead of creating another payment.
          if (
            mounted.current &&
            currentActive.current &&
            bitcoinWalletService
              .getSubmissions(view.address)
              .some(item => item.txid === signed!.txid)
          )
            router.bitcoin
              .wallet({address: view.address})
              .transaction({txid: signed.txid})
              .$replace();
        }
      } catch (cause) {
        if (
          mounted.current &&
          !controller.signal.aborted &&
          (cause as {code?: string})?.code !== 'CANCELLED'
        )
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not send the transaction.',
          );
      } finally {
        operation.current = undefined;
        if (mounted.current) setBusy(undefined);
      }
    };

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>
            {preview ? 'Review payment' : 'Send Bitcoin'}
          </ViewHeaderTitle>
        </ViewHeader>
        <ViewContent
          key={preview ? 'review' : 'form'}
          footerReveal={preview ? 'end' : 'always'}
          footer={
            account && (
              <>
                <Button
                  disabled={
                    !active ||
                    !!busy ||
                    (!preview &&
                      (!recipient.trim() ||
                        (!maximum && !amount.trim()) ||
                        !feeRate))
                  }
                  loading={!!busy}
                  onClick={() => void (preview ? submit() : review())}
                >
                  {busy === 'preparing'
                    ? 'Preparing…'
                    : busy === 'signing'
                      ? 'Signing…'
                      : busy === 'sending'
                        ? 'Sending…'
                        : preview
                          ? 'Sign and send'
                          : 'Review payment'}
                </Button>
                {preview && (
                  <Button
                    color="neutral"
                    disabled={!!busy}
                    onClick={() => {
                      setPreview(undefined);
                      setError(undefined);
                    }}
                  >
                    Edit payment
                  </Button>
                )}
              </>
            )
          }
        >
          {!account ? (
            <InfoMessage>This wallet is no longer in Safe.</InfoMessage>
          ) : (
            <>
              <WalletAccountFieldset
                keys={walletStorageService.keys}
                address={view.address}
                addressType={account.wallet.addressType}
                label="From"
              />
              {preview ? (
                <>
                  <InfoFieldset>
                    <InfoLegend>To</InfoLegend>
                    <InteractiveAddress copyable>
                      {preview.recipient}
                    </InteractiveAddress>
                  </InfoFieldset>
                  <InfoFieldset>
                    <InfoLegend>Amount</InfoLegend>
                    <InfoFieldsetValue>
                      {formatBitcoinAmount(preview.amountSats)} BTC
                    </InfoFieldsetValue>
                  </InfoFieldset>
                  <InfoTable>
                    <tbody>
                      <tr>
                        <th>Network fee</th>
                        <td>{formatBitcoinAmount(preview.feeSats)} BTC</td>
                      </tr>
                      <tr>
                        <th>Target fee rate</th>
                        <td>{preview.feeRate} sat/vB</td>
                      </tr>
                      <tr>
                        <th>Total</th>
                        <td>{formatBitcoinAmount(preview.totalSats)} BTC</td>
                      </tr>
                      <tr>
                        <th>Change to this wallet</th>
                        <td>{formatBitcoinAmount(preview.changeSats)} BTC</td>
                      </tr>
                    </tbody>
                  </InfoTable>
                  {preview.feeSats * BigInt(10) > preview.amountSats && (
                    <WarningMessage>
                      The network fee is more than 10% of the amount being sent.
                    </WarningMessage>
                  )}
                  <InfoMessage>
                    Check the address and amount before signing. This payment
                    uses Bitcoin mainnet.
                  </InfoMessage>
                </>
              ) : (
                <>
                  <InfoSection>
                    <InfoSectionItemLabel
                      as="label"
                      htmlFor="bitcoin-recipient"
                    >
                      To
                    </InfoSectionItemLabel>
                    <Input
                      id="bitcoin-recipient"
                      placeholder="Bitcoin address"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      value={recipient}
                      disabled={!!busy}
                      onChange={event => {
                        setRecipient(event.target.value);
                        setError(undefined);
                      }}
                    />
                  </InfoSection>
                  <InfoSection>
                    <InfoSectionItemLabel as="label" htmlFor="bitcoin-amount">
                      Amount (BTC)
                    </InfoSectionItemLabel>
                    <Input
                      id="bitcoin-amount"
                      inputMode="decimal"
                      placeholder={
                        maximum ? 'All available BTC, less network fee' : '0.00'
                      }
                      value={maximum ? '' : amount}
                      disabled={!!busy || maximum}
                      onChange={event => {
                        setAmount(event.target.value);
                        setError(undefined);
                      }}
                    />
                    <Button
                      color="neutral"
                      disabled={!!busy}
                      onClick={() => {
                        setMaximum(value => !value);
                        setError(undefined);
                      }}
                    >
                      {maximum ? 'Enter amount' : 'Send max'}
                    </Button>
                  </InfoSection>
                  <InfoSection>
                    <InfoSectionItemLabel>Network fee</InfoSectionItemLabel>
                    <SegmentedControl<FeeChoice>
                      aria-label="Network fee"
                      value={feeChoice}
                      disabled={!!busy}
                      options={[
                        {value: 'economy', label: 'Economy'},
                        {value: 'normal', label: 'Normal'},
                        {value: 'fast', label: 'Fast'},
                        {value: 'custom', label: 'Custom'},
                      ]}
                      onChange={value => {
                        setFeeChoice(value);
                        setError(undefined);
                      }}
                    />
                    {feeChoice === 'custom' ? (
                      <Input
                        aria-label="Fee rate in satoshis per virtual byte"
                        inputMode="decimal"
                        value={customFee}
                        disabled={!!busy}
                        onChange={event => {
                          setCustomFee(event.target.value);
                          setError(undefined);
                        }}
                      />
                    ) : (
                      <InfoSectionRow>
                        <InfoSectionItemLabel>
                          Estimated rate
                        </InfoSectionItemLabel>
                        <span>
                          {feeRate
                            ? `${feeRate} sat/vB`
                            : feeError
                              ? 'Unavailable'
                              : 'Loading…'}
                        </span>
                      </InfoSectionRow>
                    )}
                    {feeChoice === 'custom' && (
                      <InfoSectionItemLabel>sat/vB</InfoSectionItemLabel>
                    )}
                    {feeError && <InfoMessage>{feeError}</InfoMessage>}
                  </InfoSection>
                  <InfoMessage>
                    Only confirmed, available BTC can be sent. The exact fee is
                    shown before signing.
                  </InfoMessage>
                </>
              )}
            </>
          )}
          {error && <ErrorMessage>{error}</ErrorMessage>}
        </ViewContent>
        {scanContent}
      </View>
    );
  },
);
