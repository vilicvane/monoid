import {observer} from 'mobx-react-lite';
import {type ReactNode, useMemo, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {getSignedSolanaTransactionSignature} from '../../@lib/send-solana-transaction.js';
import type {Router} from '../../@routes.js';
import {useSolanaTransactionConfirmation} from '../@hooks/use-solana-transaction-confirmation.js';
import {WalletAccountList} from '../@key/wallet-account-list.js';
import {AsyncButton} from '../@ui/button.js';
import {ChainTag} from '../@ui/chain-name.js';
import {IconTagSection} from '../@ui/icon-tag.js';
import {
  InfoSection,
  InfoSectionItemLabel,
  InfoSectionRow,
} from '../@ui/info-section.js';
import {ErrorMessage} from '../@ui/message-content.js';
import {NativeAmount} from '../@ui/native-amount.js';
import {TransactionDetailsPanel} from '../@ui/transaction-details-panel.js';
import {TransactionStatus} from '../@ui/transaction-status.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../@view/index.js';

const Status = styled(TransactionStatus)`
  grid-column: 3;
  align-self: center;
  justify-self: end;
`;

export const SolanaTransactionView = observer(
  ({
    view,
  }: RouteComponentProps<
    Router['sessions']['solanaTransaction']
  >): ReactNode => {
    const {chainService, walletKitService, walletStorageService} =
      useEntrances();
    const signature = useMemo(
      () => getSignedSolanaTransactionSignature(view.signedTransaction),
      [view.signedTransaction],
    );
    const active = !view.$leaving && view.$match.$exact.$active;
    const [attempt, setAttempt] = useState(0);
    const confirmation = useSolanaTransactionConfirmation(
      view.chainId,
      signature,
      active,
      attempt,
    );
    const {status} = confirmation;
    const confirmationError = confirmation.error !== undefined;
    const retryResponse =
      walletKitService.requests.has(view.id) &&
      !walletKitService.isRespondingToRequest(view.id);

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Transaction</ViewHeaderTitle>
          <Status status={status} />
        </ViewHeader>
        <ViewContent
          footer={
            (confirmationError || retryResponse) && (
              <AsyncButton
                color="neutral"
                handler={async () => {
                  if (confirmationError) setAttempt(value => value + 1);
                  if (retryResponse) {
                    await walletKitService.resumeSolanaTransactionRequest(
                      view.id,
                      view.topic,
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
            <ChainTag chainId={view.chainId} />
          </IconTagSection>
          <InfoSection>
            <WalletAccountList
              keys={walletStorageService.keys}
              addressType="solana"
              addresses={[view.address]}
              compact
              contained
            />
          </InfoSection>
          <TransactionDetailsPanel
            hash={signature}
            explorerURL={chainService.getTransactionExplorerURL(
              view.chainId,
              signature,
            )}
          >
            {status !== 'pending' && (
              <>
                <InfoSectionRow>
                  <InfoSectionItemLabel>Slot</InfoSectionItemLabel>
                  <span>{confirmation.slot}</span>
                </InfoSectionRow>
                {confirmation.fee !== undefined && (
                  <InfoSectionRow>
                    <InfoSectionItemLabel>Transaction fee</InfoSectionItemLabel>
                    <NativeAmount
                      value={confirmation.fee}
                      currency={chainService.getNativeCurrency(view.chainId)}
                    />
                  </InfoSectionRow>
                )}
              </>
            )}
          </TransactionDetailsPanel>
          {status === 'failed' && (
            <ErrorMessage>
              {confirmation.executionError ?? 'Transaction failed.'}
            </ErrorMessage>
          )}
          {confirmationError && (
            <ErrorMessage>
              {confirmation.error instanceof Error
                ? confirmation.error.message
                : 'Could not check confirmation.'}
            </ErrorMessage>
          )}
          {retryResponse && (
            <ErrorMessage>Could not notify the website.</ErrorMessage>
          )}
        </ViewContent>
      </View>
    );
  },
);
