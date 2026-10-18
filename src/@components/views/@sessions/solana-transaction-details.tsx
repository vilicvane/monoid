import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import {useEntrances} from '../../../@entrances.js';
import type {SolanaTransactionConfirmation} from '../../../@lib/watch-solana-transaction.js';
import {WalletAccountList} from '../../@key/wallet-account-list.js';
import {ChainTag} from '../../@ui/chain-name.js';
import {IconTagSection} from '../../@ui/icon-tag.js';
import {
  InfoSection,
  InfoSectionItemLabel,
  InfoSectionRow,
} from '../../@ui/info-section.js';
import {ErrorMessage, InfoMessage} from '../../@ui/message-content.js';
import {NativeAmount} from '../../@ui/native-amount.js';
import {SolanaTokenActivity} from '../../@ui/solana-token-activity.js';
import {TransactionDetailsPanel} from '../../@ui/transaction-details-panel.js';
import {TransactionHeaderStatus} from '../../@ui/transaction-status.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../../@view/index.js';

export const SolanaTransactionDetails = observer(
  function SolanaTransactionDetails({
    chainId,
    signature,
    address,
    confirmation,
    active,
    footer,
    children,
  }: {
    chainId: string;
    signature?: string;
    address: string;
    confirmation: SolanaTransactionConfirmation;
    active: boolean;
    footer?: ReactNode;
    children?: ReactNode;
  }): ReactNode {
    const {chainService, walletStorageService} = useEntrances();
    const {status} = confirmation;

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Transaction</ViewHeaderTitle>
          <TransactionHeaderStatus status={status} />
        </ViewHeader>
        <ViewContent footer={footer}>
          <IconTagSection>
            <ChainTag chainId={chainId} />
          </IconTagSection>
          <InfoSection>
            <WalletAccountList
              keys={walletStorageService.keys}
              addressType="solana"
              addresses={[address]}
              compact
              contained
            />
          </InfoSection>
          {status === 'not-found' && (
            <InfoMessage>Transaction not found on the network.</InfoMessage>
          )}
          {(status === 'confirmed' || status === 'failed') && (
            <SolanaTokenActivity
              chainId={chainId}
              signer={address}
              balances={confirmation.balances}
            />
          )}
          {signature && (
            <TransactionDetailsPanel
              hash={signature}
              explorerURL={chainService.getTransactionExplorerURL(
                chainId,
                signature,
              )}
            >
              {(status === 'confirmed' || status === 'failed') && (
                <>
                  <InfoSectionRow>
                    <InfoSectionItemLabel>Slot</InfoSectionItemLabel>
                    <span>{confirmation.slot}</span>
                  </InfoSectionRow>
                  {confirmation.fee !== undefined && (
                    <InfoSectionRow>
                      <InfoSectionItemLabel>
                        Transaction fee
                      </InfoSectionItemLabel>
                      <NativeAmount
                        value={confirmation.fee}
                        currency={chainService.getNativeCurrency(chainId)}
                      />
                    </InfoSectionRow>
                  )}
                </>
              )}
            </TransactionDetailsPanel>
          )}
          {status === 'failed' && (
            <ErrorMessage>
              {confirmation.executionError ?? 'Transaction failed.'}
            </ErrorMessage>
          )}
          {confirmation.error !== undefined && (
            <ErrorMessage>
              {confirmation.error instanceof Error
                ? confirmation.error.message
                : 'Could not check confirmation.'}
            </ErrorMessage>
          )}
          {children}
        </ViewContent>
      </View>
    );
  },
);
