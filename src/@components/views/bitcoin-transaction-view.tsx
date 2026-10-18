import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import type {BitcoinTransaction} from '../../@lib/bitcoin-api.js';
import {formatBitcoinAmount} from '../../@lib/bitcoin-transaction.js';
import {getBitcoinWalletSigningAccount} from '../../@lib/bitcoin-wallet.js';
import type {Router} from '../../@routes.js';
import {WalletAccountFieldset} from '../@key/wallet-account-fieldset.js';
import {Button} from '../@ui/button.js';
import {PopupDateTime} from '../@ui/date-time.js';
import {
  InfoFieldset,
  InfoFieldsetValue,
  InfoLegend,
  InfoSectionItemLabel,
  InfoSectionRow,
} from '../@ui/info-section.js';
import {InteractiveAddress} from '../@ui/interactive-address.js';
import {
  ErrorMessage,
  InfoMessage,
  WarningMessage,
} from '../@ui/message-content.js';
import {TransactionDetailsPanel} from '../@ui/transaction-details-panel.js';
import {TransactionHeaderStatus} from '../@ui/transaction-status.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../@view/index.js';

export const BitcoinTransactionView = observer(
  ({
    view,
  }: RouteComponentProps<
    Router['bitcoin']['wallet']['transaction']
  >): ReactNode => {
    const {bitcoinWalletService, walletStorageService} = useEntrances();
    const active = !view.$leaving && view.$match.$exact.$active;
    const account = getBitcoinWalletSigningAccount(
      walletStorageService.keys,
      view.address,
    );
    const submission = bitcoinWalletService
      .getSubmissions(view.address)
      .find(item => item.txid === view.txid);
    const cached = bitcoinWalletService
      .get(view.address)
      .snapshot?.transactions.find(item => item.txid === view.txid);
    const [loaded, setLoaded] = useState<{
      transaction: BitcoinTransaction;
      tip: number;
    }>();
    const [error, setError] = useState<string>();
    const [loading, setLoading] = useState(true);
    const [sending, setSending] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const broadcast = useRef<AbortController | undefined>(undefined);

    useEffect(() => {
      if (!active) return;
      const controller = new AbortController();
      let pending = false;
      const refresh = async (): Promise<void> => {
        if (pending) return;
        pending = true;
        setLoading(true);
        try {
          const [transaction, tip] = await Promise.all([
            bitcoinWalletService.api.getTransaction(
              view.txid,
              controller.signal,
            ),
            bitcoinWalletService.api.getTipHeight(controller.signal),
          ]);
          if (controller.signal.aborted) return;
          setLoaded({transaction, tip});
          setError(undefined);
          await bitcoinWalletService.updateSubmissionStatus(
            view.txid,
            transaction.status.confirmed ? 'confirmed' : 'submitted',
          );
        } catch (cause) {
          if (!controller.signal.aborted)
            setError(
              cause instanceof Error
                ? cause.message
                : 'Could not check this transaction.',
            );
        } finally {
          pending = false;
          if (!controller.signal.aborted) setLoading(false);
        }
      };
      void refresh();
      const timer = setInterval(() => {
        if (document.visibilityState === 'visible') void refresh();
      }, 30_000);
      return () => {
        controller.abort();
        broadcast.current?.abort();
        clearInterval(timer);
      };
    }, [active, attempt, bitcoinWalletService, view.txid]);

    const transaction = loaded?.transaction;
    const status = transaction?.status ?? cached?.status;
    const confirmed = status
      ? status.confirmed
      : submission?.status === 'confirmed';
    const observed = !!transaction || !!cached;
    const staleStatus =
      !!error &&
      (observed ||
        submission?.status === 'confirmed' ||
        submission?.status === 'submitted');
    const confirmations = status?.confirmed
      ? loaded
        ? Math.max(0, loaded.tip - status.blockHeight + 1)
        : cached?.confirmations
      : undefined;
    const received = transaction?.outputs
      .filter(output => output.address === view.address)
      .reduce((sum, output) => sum + output.value, BigInt(0));
    const spent = transaction?.inputs.reduce(
      (sum, input) =>
        sum +
        (input.previousOutput?.address === view.address
          ? input.previousOutput.value
          : BigInt(0)),
      BigInt(0),
    );
    const net =
      received !== undefined && spent !== undefined
        ? received - spent
        : cached?.netSats;
    const payment = submission?.payment;
    const fee =
      transaction?.fee ??
      cached?.fee ??
      (payment ? BigInt(payment.feeSats) : undefined);
    const label = confirmed
      ? 'Confirmed'
      : observed || submission?.status === 'submitted'
        ? 'Pending confirmation'
        : submission?.status === 'rejected'
          ? 'Broadcast rejected'
          : submission?.status === 'unknown'
            ? 'Broadcast unconfirmed'
            : submission
              ? 'Signed'
              : error
                ? 'Status unavailable'
                : 'Checking transaction';

    const retry = async (): Promise<void> => {
      if (!submission || broadcast.current || !active) return;
      const controller = new AbortController();
      broadcast.current = controller;
      setSending(true);
      setError(undefined);
      try {
        await bitcoinWalletService.broadcast(
          view.address,
          submission,
          controller.signal,
        );
        if (!controller.signal.aborted) setAttempt(value => value + 1);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Broadcast could not be confirmed.',
          );
      } finally {
        broadcast.current = undefined;
        setSending(false);
      }
    };

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Transaction</ViewHeaderTitle>
          <TransactionHeaderStatus
            status={
              confirmed
                ? 'confirmed'
                : observed || submission?.status === 'submitted'
                  ? 'pending'
                  : submission?.status === 'rejected'
                    ? 'failed'
                    : submission?.status === 'unknown'
                      ? 'not-found'
                      : submission
                        ? 'signed'
                        : loading
                          ? 'pending'
                          : 'not-found'
            }
          />
        </ViewHeader>
        <ViewContent
          footer={
            <>
              {submission && !confirmed && (
                <Button
                  disabled={!active || sending}
                  loading={sending}
                  onClick={() => void retry()}
                >
                  Retry broadcast
                </Button>
              )}
              <Button
                color="neutral"
                disabled={!active || sending}
                loading={loading}
                onClick={() => setAttempt(value => value + 1)}
              >
                Refresh
              </Button>
            </>
          }
        >
          {account && (
            <WalletAccountFieldset
              keys={walletStorageService.keys}
              address={view.address}
              addressType={account.wallet.addressType}
              label="Wallet"
            />
          )}
          {payment && (
            <>
              <InfoFieldset>
                <InfoLegend>To</InfoLegend>
                <InteractiveAddress copyable>
                  {payment.recipient}
                </InteractiveAddress>
              </InfoFieldset>
              <InfoFieldset>
                <InfoLegend>Amount sent</InfoLegend>
                <InfoFieldsetValue>
                  {formatBitcoinAmount(BigInt(payment.amountSats))} BTC
                </InfoFieldsetValue>
              </InfoFieldset>
            </>
          )}
          {net !== undefined && (
            <InfoFieldset>
              <InfoLegend>Balance change</InfoLegend>
              <InfoFieldsetValue>
                {net > BigInt(0) ? '+' : ''}
                {formatBitcoinAmount(net)} BTC
              </InfoFieldsetValue>
            </InfoFieldset>
          )}
          <TransactionDetailsPanel
            hash={view.txid}
            explorerURL={`https://blockstream.info/tx/${encodeURIComponent(view.txid)}`}
          >
            <InfoSectionRow>
              <InfoSectionItemLabel>Status</InfoSectionItemLabel>
              <span>
                {label}
                {staleStatus ? ' (last checked)' : ''}
              </span>
            </InfoSectionRow>
            {confirmations !== undefined && (
              <InfoSectionRow>
                <InfoSectionItemLabel>Confirmations</InfoSectionItemLabel>
                <span>{confirmations}</span>
              </InfoSectionRow>
            )}
            {fee !== undefined && (
              <InfoSectionRow>
                <InfoSectionItemLabel>Network fee</InfoSectionItemLabel>
                <span>{formatBitcoinAmount(fee)} BTC</span>
              </InfoSectionRow>
            )}
            {status?.confirmed && (
              <InfoSectionRow>
                <InfoSectionItemLabel>Confirmed</InfoSectionItemLabel>
                <PopupDateTime value={status.blockTime * 1000} />
              </InfoSectionRow>
            )}
            {submission && (
              <InfoSectionRow>
                <InfoSectionItemLabel>Created</InfoSectionItemLabel>
                <PopupDateTime value={submission.createdAt} />
              </InfoSectionRow>
            )}
          </TransactionDetailsPanel>
          {submission && !confirmed && (
            <InfoMessage>
              Retry broadcasts the same signed transaction. It does not create
              another payment.
            </InfoMessage>
          )}
          {submission?.status === 'unknown' && !observed && (
            <WarningMessage>
              The service has not confirmed whether this payment was accepted.
              Its inputs remain reserved until the transaction is resolved.
            </WarningMessage>
          )}
          {submission?.error &&
            !observed &&
            !error &&
            submission.status !== 'unknown' && (
              <WarningMessage>{submission.error}</WarningMessage>
            )}
          {net !== undefined && net < BigInt(0) && (
            <InfoMessage>
              The balance change includes the network fee.
            </InfoMessage>
          )}
          {error && <ErrorMessage>{error}</ErrorMessage>}
          {staleStatus && (
            <WarningMessage>
              The current transaction status could not be checked. The details
              above show the last successful update.
            </WarningMessage>
          )}
        </ViewContent>
      </View>
    );
  },
);
