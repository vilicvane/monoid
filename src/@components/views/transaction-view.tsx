import {IonIcon} from '@ionic/react';
import {Transaction} from 'ethers';
import check from 'lucide-static/icons/check.svg';
import externalLink from 'lucide-static/icons/external-link.svg';
import x from 'lucide-static/icons/x.svg';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useMemo, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {
  type EvmTransactionConfirmation,
  watchEvmTransaction,
} from '../../@lib/watch-evm-transaction.js';
import type {Router} from '../../@routes.js';
import {popInAnimationCSS} from '../@animations.js';
import {WalletAccountList} from '../@key/wallet-account-list.js';
import {AsyncButton} from '../@ui/button.js';
import {ChainTag} from '../@ui/chain-name.js';
import {CopyButton} from '../@ui/copy-button.js';
import {EllipsisInMiddle} from '../@ui/ellipsis-in-middle.js';
import {EvmTokenActivity} from '../@ui/evm-token-activity.js';
import {IconTagSection} from '../@ui/icon-tag.js';
import {
  InfoFieldset,
  InfoFieldsetValue,
  InfoLegend,
  InfoPanel,
  InfoSection,
  InfoSectionHeader,
  InfoSectionItemLabel,
  InfoSectionRow,
} from '../@ui/info-section.js';
import {inlineIconCSS, inlineIconRowCSS} from '../@ui/inline-icon.js';
import {LoadingSpinner} from '../@ui/loading-spinner.js';
import {ErrorMessage, MessageSectionTitle} from '../@ui/message-content.js';
import {NativeAmount} from '../@ui/native-amount.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../@view/index.js';

const Status = styled.div`
  grid-column: 3;
  align-self: center;
  justify-self: end;
  display: flex;
`;

const StatusIcon = styled.div<{$status: EvmTransactionConfirmation['status']}>`
  ${popInAnimationCSS}
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  font-size: 24px;
  color: ${({$status}) =>
    $status === 'confirmed'
      ? 'var(--ion-color-safe)'
      : $status === 'failed'
        ? 'var(--ion-color-danger)'
        : 'var(--ion-color-primary)'};

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const Hash = styled(CopyButton)`
  flex: 1;
  min-width: 0;

  > :first-child {
    flex: 1;
    min-width: 0;
  }
`;

const ExplorerLink = styled.a`
  ${inlineIconRowCSS}
  font-size: 14px;
  text-decoration: none;

  > ion-icon {
    ${inlineIconCSS}
    color: inherit;
  }
`;

export const TransactionView = observer(
  ({
    view,
  }: RouteComponentProps<Router['sessions']['transaction']>): ReactNode => {
    const {chainService, walletKitService, walletStorageService} =
      useEntrances();
    const transaction = useMemo(
      () => Transaction.from(view.signedTransaction),
      [view.signedTransaction],
    );
    const chainId = `eip155:${transaction.chainId}`;
    const currency = chainService.getNativeCurrency(chainId);
    const hash = transaction.hash!;
    const explorerURL = chainService.getTransactionExplorerURL(chainId, hash);
    const active = !view.$leaving && view.$match.$exact.$active;
    const [confirmation, setConfirmation] =
      useState<EvmTransactionConfirmation>({
        status: 'pending',
      });
    const [attempt, setAttempt] = useState(0);
    const {status} = confirmation;
    const receipt = status === 'pending' ? undefined : confirmation.receipt;
    const responsePending = walletKitService.requests.has(view.id);
    const responding = walletKitService.isRespondingToRequest(view.id);
    const retryResponse = responsePending && !responding;
    const confirmationError =
      status === 'pending' && confirmation.error !== undefined;

    useEffect(() => {
      if (!active || status !== 'pending') return;
      return watchEvmTransaction({
        chainId: transaction.chainId,
        hash,
        getProvider: () => chainService.getRPC(chainId),
        onChange: setConfirmation,
      });
    }, [active, status, transaction, hash, chainId, chainService, attempt]);

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Transaction</ViewHeaderTitle>
          <Status
            role="status"
            aria-live="polite"
            aria-label={
              status === 'pending'
                ? 'Pending confirmation'
                : status === 'confirmed'
                  ? 'Confirmed'
                  : 'Failed'
            }
          >
            <StatusIcon key={status} $status={status} aria-hidden="true">
              {status === 'pending' ? (
                <LoadingSpinner />
              ) : (
                <IonIcon icon={status === 'confirmed' ? check : x} />
              )}
            </StatusIcon>
          </Status>
        </ViewHeader>
        <ViewContent
          footer={
            (confirmationError || retryResponse) && (
              <AsyncButton
                color="neutral"
                handler={async () => {
                  if (confirmationError) {
                    setConfirmation({status: 'pending'});
                    setAttempt(value => value + 1);
                  }
                  if (retryResponse) {
                    await walletKitService.approveTransactionRequest(
                      view.id,
                      view.topic,
                      transaction.unsignedSerialized,
                      transaction.signature!.serialized,
                    );
                  }
                }}
              >
                Refresh
              </AsyncButton>
            )
          }
        >
          <IconTagSection>
            <ChainTag chainId={chainId} />
          </IconTagSection>
          <InfoSection>
            <WalletAccountList
              keys={walletStorageService.keys}
              addressType="evm"
              addresses={[transaction.from!]}
              contained
            />
          </InfoSection>
          {transaction.value > BigInt(0) && status !== 'failed' && (
            <InfoFieldset $equalPadding>
              <InfoLegend>Amount</InfoLegend>
              <InfoFieldsetValue>
                <NativeAmount value={transaction.value} currency={currency} />
              </InfoFieldsetValue>
            </InfoFieldset>
          )}
          {receipt && (
            <EvmTokenActivity
              key={hash}
              chainId={chainId}
              signer={transaction.from!}
              receipt={receipt}
            />
          )}
          <InfoSection $alignBottom>
            <InfoSectionHeader>
              <MessageSectionTitle>Details</MessageSectionTitle>
              {explorerURL && (
                <ExplorerLink
                  href={explorerURL}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="View on explorer"
                >
                  <IonIcon icon={externalLink} aria-hidden="true" />
                </ExplorerLink>
              )}
            </InfoSectionHeader>
            <InfoPanel role="group" aria-label="Transaction details">
              <InfoSectionRow>
                <InfoSectionItemLabel>Hash</InfoSectionItemLabel>
                <Hash value={hash} label="Copy transaction hash">
                  <EllipsisInMiddle>{hash}</EllipsisInMiddle>
                </Hash>
              </InfoSectionRow>
              {receipt && (
                <>
                  <InfoSectionRow>
                    <InfoSectionItemLabel>Block</InfoSectionItemLabel>
                    <span>{receipt.blockNumber}</span>
                  </InfoSectionRow>
                  <InfoSectionRow>
                    <InfoSectionItemLabel>Execution fee</InfoSectionItemLabel>
                    <NativeAmount value={receipt.fee} currency={currency} />
                  </InfoSectionRow>
                </>
              )}
            </InfoPanel>
          </InfoSection>
          {confirmationError && (
            <ErrorMessage>Could not check confirmation.</ErrorMessage>
          )}
          {retryResponse && (
            <ErrorMessage>Could not notify the website.</ErrorMessage>
          )}
        </ViewContent>
      </View>
    );
  },
);
