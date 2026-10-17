import {IonIcon} from '@ionic/react';
import externalLink from 'lucide-static/icons/external-link.svg';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../@entrances.js';
import type {EvmTransaction} from '../../../@lib/evm-transaction.js';
import type {EvmTransactionConfirmation} from '../../../@lib/watch-evm-transaction.js';
import {WalletAccountList} from '../../@key/wallet-account-list.js';
import {getWalletSigningAccount} from '../../@monoid/get-wallet-signing-account.js';
import {Button} from '../../@ui/button.js';
import {ChainTag} from '../../@ui/chain-name.js';
import {CopyButton} from '../../@ui/copy-button.js';
import {EllipsisInMiddle} from '../../@ui/ellipsis-in-middle.js';
import {EvmTokenActivity} from '../../@ui/evm-token-activity.js';
import {IconTagSection} from '../../@ui/icon-tag.js';
import {
  InfoFieldset,
  InfoFieldsetValue,
  InfoLegend,
  InfoPanel,
  InfoSection,
  InfoSectionHeader,
  InfoSectionItemLabel,
  InfoSectionRow,
} from '../../@ui/info-section.js';
import {inlineIconCSS, inlineIconRowCSS} from '../../@ui/inline-icon.js';
import {
  MessageSectionTags,
  MessageSectionTitle,
} from '../../@ui/message-content.js';
import {NativeAmount} from '../../@ui/native-amount.js';
import {WarningTag} from '../../@ui/tag.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../../@view/index.js';

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

export const TransactionDetails = observer(function TransactionDetails({
  transaction,
  confirmation,
  address = transaction.from,
  active,
  footer,
  children,
}: {
  transaction: EvmTransaction;
  confirmation: EvmTransactionConfirmation;
  address?: string;
  active: boolean;
  footer?: ReactNode;
  children?: ReactNode;
}): ReactNode {
  const {
    router,
    chainService,
    walletStorageService,
    transactionHistoryService,
  } = useEntrances();
  const chainId = `eip155:${transaction.chainId}`;
  const currency = chainService.getNativeCurrency(chainId);
  const {hash} = transaction;
  const explorerURL = chainService.getTransactionExplorerURL(chainId, hash);
  const {status} = confirmation;
  const receipt = 'receipt' in confirmation ? confirmation.receipt : undefined;
  const detail = transactionHistoryService.get(transaction.from, chainId, hash);
  const canReplace =
    detail &&
    getWalletSigningAccount(walletStorageService.keys, transaction.from) &&
    (!!detail.submission || (status === 'pending' && !confirmation.nonceUsed));
  const replace = (kind: 'speed-up' | 'cancel'): void => {
    router.transactions
      .wallet({address: transaction.from})
      .transaction({chainId, hash})
      .replace({kind})
      .$push();
  };
  const actions =
    canReplace || footer || status === 'replaced' ? (
      <>
        {canReplace &&
          (detail.submission ? (
            <Button onClick={() => replace(detail.submission!.kind)}>
              Resume replacement
            </Button>
          ) : (
            <>
              <Button onClick={() => replace('speed-up')}>Speed up</Button>
              <Button color="neutral" onClick={() => replace('cancel')}>
                Cancel transaction
              </Button>
            </>
          ))}
        {footer}
        {status === 'replaced' && (
          <Button
            color="neutral"
            onClick={() =>
              router.transactions
                .wallet({address: transaction.from})
                .transaction({chainId, hash: confirmation.replacementHash})
                .$push()
            }
          >
            View replacement
          </Button>
        )}
      </>
    ) : undefined;

  return (
    <View inert={!active}>
      <ViewHeader>
        <ViewHeaderTitle>Transaction</ViewHeaderTitle>
      </ViewHeader>
      <ViewContent footer={actions}>
        <IconTagSection>
          <ChainTag chainId={chainId} />
        </IconTagSection>
        <InfoSection>
          <WalletAccountList
            keys={walletStorageService.keys}
            addressType="evm"
            addresses={[address]}
            compact
            contained
          />
        </InfoSection>
        {transaction.value > BigInt(0) &&
          (status === 'pending' || status === 'confirmed') && (
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
            signer={transaction.from}
            account={address}
            receipt={receipt}
          />
        )}
        {status === 'pending' && confirmation.nonceUsed && (
          <InfoSection>
            <InfoSectionItemLabel>
              This nonce has already been used. Waiting for the transaction
              result.
            </InfoSectionItemLabel>
          </InfoSection>
        )}
        <InfoSection>
          <InfoSectionHeader>
            <MessageSectionTags>
              <MessageSectionTitle>Details</MessageSectionTitle>
              {status === 'replaced' && <WarningTag>Replaced</WarningTag>}
            </MessageSectionTags>
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
        {children}
      </ViewContent>
    </View>
  );
});
