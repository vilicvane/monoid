import {BookUser as bookUser, ScanLine as scanLine} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';
import {UnmountAnimationClone} from 'unmount-animation-clone';

import {useEntrances} from '../../@entrances.js';
import type {BitcoinFeeRates} from '../../@lib/bitcoin-api.js';
import {parseBitcoinPaymentRequest} from '../../@lib/bitcoin-payment-request.js';
import {
  type BitcoinTransactionPreview,
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
import {popOutAnimationCSS} from '../@animations.js';
import {WalletAccountFieldset} from '../@key/wallet-account-fieldset.js';
import {
  MonoidScanStatePromptProgress,
  useMonoidScanPrompt,
} from '../@monoid/monoid-scan-prompt.js';
import {AppIcon} from '../@ui/app-icon.js';
import {Button} from '../@ui/button.js';
import {ExpandableAddress} from '../@ui/expandable-address.js';
import {IconButton} from '../@ui/icon-button.js';
import {
  InfoFieldset,
  InfoFieldsetHeader,
  InfoFieldsetValue,
  InfoLegend,
} from '../@ui/info-section.js';
import {Input} from '../@ui/input.js';
import {
  ErrorMessage,
  MessageSectionTags,
  WarningMessage,
} from '../@ui/message-content.js';
import {NativeAmount} from '../@ui/native-amount.js';
import {QrScanPopup} from '../@ui/qr-scan-popup.js';
import {WhiteTag} from '../@ui/tag.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  ViewPlaceholder,
} from '../@view/index.js';

import {BitcoinFeeDetails} from './@bitcoin/bitcoin-fee-details.js';
import type {BitcoinFeeChoice} from './@bitcoin/bitcoin-fee-editor.js';
import {BitcoinRecipientPicker} from './@bitcoin/bitcoin-recipient-picker.js';
import {getBitcoinRecipients} from './@bitcoin/bitcoin-recipients.js';

const BTC = {symbol: 'BTC', decimals: 8};

const InputFieldset = styled(InfoFieldset)`
  &:focus-within::before {
    border-color: var(--ion-color-medium-shade);
  }
`;

const InputRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
`;

const FieldInput = styled(Input)`
  flex: 1;
  min-width: 0;
  width: 0;
  height: 21px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 0;
  outline: none;
  font-size: 16px;
  line-height: 21px;
  color: var(--ion-color-dark);

  &:not(:focus) {
    color: var(--ion-color-dark);
  }
`;

const AmountInput = styled(FieldInput)<{$compact: boolean}>`
  width: 100%;
  flex: none;
  height: 42px;
  font-size: ${props => (props.$compact ? 24 : 32)}px;
  line-height: 42px;
  font-variant-numeric: tabular-nums;
  text-align: center;

  &::placeholder {
    color: var(--ion-color-medium-tint);
    opacity: 1;
  }
`;

const AmountTags = styled(MessageSectionTags)`
  > ${InfoLegend}:first-child:not(:last-child) {
    margin-right: calc(-1 * var(--tag-overlap) - var(--tag-inline-margin));
  }
`;

const MaxToggle = styled(WhiteTag).attrs({as: 'button', type: 'button'})`
  margin-left: auto;
  margin-right: calc(
    var(--info-fieldset-label-inset) - var(--info-fieldset-padding) - var(
        --info-fieldset-border-width
      ) - var(--tag-inline-margin)
  );
  color: var(--ion-color-medium-tint);
  cursor: pointer;

  &[aria-pressed='true'] {
    background: var(--ion-color-primary);
    border-color: var(--ion-color-primary-shade);
    color: var(--ion-color-primary-contrast);
  }

  &.unmount {
    ${popOutAnimationCSS}
    pointer-events: none;
  }

  @media (prefers-reduced-motion: reduce) {
    &.unmount {
      animation-duration: 0s;
    }
  }
`;

const InputActions = styled.div`
  display: flex;
  align-items: center;
  flex-shrink: 0;
  height: 21px;
  gap: 0;
  margin-right: -6px;
`;

const RecipientButton = styled(IconButton)<{$known: boolean}>`
  ${({$known}) => $known && 'color: var(--ion-color-primary);'}
`;

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
    const {addresses: recipientAddresses} = getBitcoinRecipients(
      walletStorageService.keys,
      bitcoinWalletService.getSubmissions(view.address),
    );
    let knownRecipient = false;

    try {
      knownRecipient = recipientAddresses.has(
        validateBitcoinAddress(recipient),
      );
    } catch {
      // An incomplete address is not a selected recipient.
    }

    const [amount, setAmount] = useState('');
    const [maximum, setMaximum] = useState(false);
    const [fees, setFees] = useState<BitcoinFeeRates>();
    const [feeError, setFeeError] = useState<string>();
    const [feeChoice, setFeeChoice] = useState<BitcoinFeeChoice>('normal');
    const [customFee, setCustomFee] = useState('1');
    const [popup, setPopup] = useState<'recipient' | 'scan'>();
    const amountInput = useRef<HTMLInputElement>(null);
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
        setPopup(undefined);
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
            setFeeError('Fee estimates unavailable. Set a custom rate.');
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

    const acceptRecipient = (value: string): void => {
      if (
        !mounted.current ||
        !currentActive.current ||
        operation.current ||
        preview
      )
        return;
      const request = parseBitcoinPaymentRequest(value);
      setRecipient(request.address);
      if (request.amount !== undefined) {
        setAmount(request.amount);
        setMaximum(false);
      }
      setError(undefined);
      setPopup(undefined);
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
            signed = await signBitcoinTransaction(
              applet,
              account.reference,
              preview,
              check,
              (current, total) => {
                check();
                setContent(
                  <MonoidScanStatePromptProgress
                    current={current}
                    total={total}
                  >
                    Signing
                  </MonoidScanStatePromptProgress>,
                );
              },
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
            <ViewPlaceholder>This wallet is no longer in Safe.</ViewPlaceholder>
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
                    <ExpandableAddress>{preview.recipient}</ExpandableAddress>
                  </InfoFieldset>
                  <InfoFieldset $equalPadding>
                    <InfoLegend>Amount</InfoLegend>
                    <InfoFieldsetValue>
                      <NativeAmount value={preview.amountSats} currency={BTC} />
                    </InfoFieldsetValue>
                  </InfoFieldset>
                  <BitcoinFeeDetails
                    fees={fees}
                    feeError={feeError}
                    choice={feeChoice}
                    customFee={customFee}
                    preview={preview}
                    disabled={!active || !!busy}
                  />
                  {preview.feeSats * BigInt(10) > preview.amountSats && (
                    <WarningMessage>
                      Network fee exceeds 10% of the amount.
                    </WarningMessage>
                  )}
                </>
              ) : (
                <>
                  <InputFieldset>
                    <InfoFieldsetHeader>
                      <InfoLegend as="span">To</InfoLegend>
                    </InfoFieldsetHeader>
                    <InputRow>
                      <FieldInput
                        id="bitcoin-recipient"
                        aria-label="To"
                        placeholder="Bitcoin address"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        value={recipient}
                        disabled={!!busy}
                        onPaste={event => {
                          const value = event.clipboardData.getData('text');
                          if (!/^bitcoin:/i.test(value.trim())) return;
                          event.preventDefault();
                          try {
                            acceptRecipient(value);
                          } catch (cause) {
                            setError((cause as Error).message);
                          }
                        }}
                        onChange={event => {
                          setRecipient(event.target.value);
                          setError(undefined);
                        }}
                      />
                      <InputActions>
                        <RecipientButton
                          $known={knownRecipient}
                          aria-label="Choose address"
                          feedback="color"
                          aria-haspopup="dialog"
                          disabled={!!busy}
                          onClick={() => setPopup('recipient')}
                        >
                          <AppIcon icon={bookUser} aria-hidden="true" />
                        </RecipientButton>
                        <IconButton
                          aria-label="Scan address"
                          feedback="color"
                          aria-haspopup="dialog"
                          disabled={!!busy}
                          onClick={() => setPopup('scan')}
                        >
                          <AppIcon icon={scanLine} aria-hidden="true" />
                        </IconButton>
                      </InputActions>
                    </InputRow>
                  </InputFieldset>
                  <InputFieldset $equalPadding>
                    <InfoFieldsetHeader>
                      <AmountTags>
                        <InfoLegend as="span">Amount</InfoLegend>
                        <WhiteTag as="span">BTC</WhiteTag>
                      </AmountTags>
                      {!busy && (
                        <UnmountAnimationClone
                          onUnmountClone={clone => {
                            clone.inert = true;
                            clone.setAttribute('aria-hidden', 'true');
                          }}
                        >
                          <MaxToggle
                            aria-pressed={maximum}
                            onClick={() => {
                              setMaximum(value => !value);
                              setError(undefined);
                              if (maximum)
                                requestAnimationFrame(() =>
                                  amountInput.current?.focus(),
                                );
                            }}
                          >
                            Max
                          </MaxToggle>
                        </UnmountAnimationClone>
                      )}
                    </InfoFieldsetHeader>
                    <AmountInput
                      $compact={!maximum && amount.length > 14}
                      ref={amountInput}
                      id="bitcoin-amount"
                      aria-label="Amount (BTC)"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={maximum ? 'Max' : amount}
                      readOnly={maximum}
                      disabled={!!busy}
                      onChange={event => {
                        setAmount(event.target.value);
                        setError(undefined);
                      }}
                    />
                  </InputFieldset>
                  <BitcoinFeeDetails
                    fees={fees}
                    feeError={feeError}
                    choice={feeChoice}
                    customFee={customFee}
                    disabled={!active || !!busy}
                    onApply={(choice, value) => {
                      setFeeChoice(choice);
                      setCustomFee(value);
                      setError(undefined);
                    }}
                  />
                </>
              )}
            </>
          )}
          {error && <ErrorMessage>{error}</ErrorMessage>}
        </ViewContent>
        {active && account && !busy && !preview && popup === 'recipient' && (
          <BitcoinRecipientPicker
            address={view.address}
            onSelect={acceptRecipient}
            onDismiss={() => setPopup(undefined)}
          />
        )}
        {active && account && !busy && !preview && popup === 'scan' && (
          <QrScanPopup
            validate={value => {
              try {
                parseBitcoinPaymentRequest(value);
                return undefined;
              } catch (cause) {
                return (cause as Error).message;
              }
            }}
            onScan={acceptRecipient}
            onDismiss={() => setPopup(undefined)}
          />
        )}
        {scanContent}
      </View>
    );
  },
);
