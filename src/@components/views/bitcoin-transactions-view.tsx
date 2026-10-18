import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import {getBitcoinWalletSigningAccount} from '../../@lib/bitcoin-wallet.js';
import type {Router} from '../../@routes.js';
import {useBitcoinWalletRefresh} from '../@hooks/use-bitcoin-wallet-refresh.js';
import {WalletAccountList} from '../@key/wallet-account-list.js';
import {Button} from '../@ui/button.js';
import {PopupDateTime} from '../@ui/date-time.js';
import {InfoSection, InfoSectionItemLabel} from '../@ui/info-section.js';
import {ErrorMessage, WarningMessage} from '../@ui/message-content.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  ViewLoading,
  ViewPlaceholder,
} from '../@view/index.js';

import {
  BitcoinSubmissionListItem,
  BitcoinTransactionListItem,
} from './@sessions/bitcoin-transaction-list.js';
import {TransactionList} from './@sessions/transaction-list.js';

export const BitcoinTransactionsView = observer(
  ({
    view,
  }: RouteComponentProps<
    Router['bitcoin']['wallet']['transactions']
  >): ReactNode => {
    const {router, walletStorageService, bitcoinWalletService} = useEntrances();
    const active = !view.$leaving && view.$match.$exact.$active;
    const account = getBitcoinWalletSigningAccount(
      walletStorageService.keys,
      view.address,
    );
    const state = bitcoinWalletService.get(view.address);
    const {snapshot} = state;
    const transactions = snapshot?.transactions ?? [];
    const transactionIds = new Set(
      transactions.map(transaction => transaction.txid),
    );
    const submissions = bitcoinWalletService
      .getSubmissions(view.address)
      .filter(
        submission =>
          submission.status !== 'confirmed' &&
          !transactionIds.has(submission.txid),
      );
    const hasTransactions = transactions.length > 0 || submissions.length > 0;
    const route = router.bitcoin.wallet({address: view.address});

    useBitcoinWalletRefresh(view.address, active && !!account);

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Transactions</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent>
          {!account ? (
            <ViewPlaceholder>
              This Bitcoin wallet is no longer in Safe.
            </ViewPlaceholder>
          ) : (
            <>
              <InfoSection>
                <WalletAccountList
                  keys={walletStorageService.keys}
                  addressType={account.wallet.addressType}
                  addresses={[view.address]}
                  compact
                  contained
                />
              </InfoSection>
              {hasTransactions && (
                <InfoSectionItemLabel>Choose transaction</InfoSectionItemLabel>
              )}
              {state.error && (
                <ErrorMessage>
                  {state.error}
                  {snapshot && (
                    <span>
                      Showing cached transactions from{' '}
                      <PopupDateTime value={snapshot.updatedAt} />.
                    </span>
                  )}
                </ErrorMessage>
              )}
              {snapshot?.pendingHistoryTruncated && (
                <WarningMessage>
                  There are more pending transactions than can be shown.
                </WarningMessage>
              )}
              {hasTransactions ? (
                <TransactionList>
                  {submissions.map(submission => (
                    <BitcoinSubmissionListItem
                      key={submission.txid}
                      submission={submission}
                      onClick={() =>
                        route.transaction({txid: submission.txid}).$push()
                      }
                    />
                  ))}
                  {transactions.map(transaction => (
                    <BitcoinTransactionListItem
                      key={transaction.txid}
                      transaction={transaction}
                      onClick={() =>
                        route.transaction({txid: transaction.txid}).$push()
                      }
                    />
                  ))}
                </TransactionList>
              ) : snapshot ? (
                <ViewPlaceholder>No transactions</ViewPlaceholder>
              ) : state.status !== 'error' ? (
                <ViewLoading />
              ) : null}
              {state.historyError && (
                <ErrorMessage>{state.historyError}</ErrorMessage>
              )}
              {snapshot?.hasMore && (
                <Button
                  color="neutral"
                  loading={state.loadingMore}
                  disabled={state.status === 'loading'}
                  onClick={() =>
                    void bitcoinWalletService.loadMore(view.address)
                  }
                >
                  Load more
                </Button>
              )}
            </>
          )}
        </ViewContent>
      </View>
    );
  },
);
