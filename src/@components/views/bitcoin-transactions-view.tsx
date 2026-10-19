import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import {getBitcoinWalletSigningAccount} from '../../@lib/bitcoin-wallet.js';
import type {Router} from '../../@routes.js';
import {useBitcoinWalletRefresh} from '../@hooks/use-bitcoin-wallet-refresh.js';
import {Button} from '../@ui/button.js';
import {PopupDateTime} from '../@ui/date-time.js';
import {ErrorMessage, WarningMessage} from '../@ui/message-content.js';
import {useViewActive} from '../@view/index.js';

import {
  BitcoinSubmissionListItem,
  BitcoinTransactionListItem,
} from './@sessions/bitcoin-transaction-list.js';
import {TransactionsPage} from './@transactions/transactions-page.js';

export const BitcoinTransactionsView = observer(
  ({
    view,
  }: RouteComponentProps<
    Router['bitcoin']['wallet']['transactions']
  >): ReactNode => {
    const {router, walletStorageService, bitcoinWalletService} = useEntrances();
    const isViewActive = useViewActive(view);
    const active = isViewActive();
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
      <TransactionsPage
        active={active}
        keys={walletStorageService.keys}
        account={
          account && {
            address: view.address,
            addressType: account.wallet.addressType,
          }
        }
        unavailableMessage="This Bitcoin wallet is no longer in Safe."
        hasTransactions={hasTransactions}
        loading={!snapshot && state.status !== 'error'}
        emptyMessage={snapshot ? 'No transactions' : null}
        beforeList={
          <>
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
          </>
        }
        afterList={
          <>
            {state.historyError && (
              <ErrorMessage>{state.historyError}</ErrorMessage>
            )}
            {snapshot?.hasMore && (
              <Button
                color="neutral"
                loading={state.loadingMore}
                disabled={state.status === 'loading'}
                onClick={() => {
                  if (!isViewActive()) return;
                  void bitcoinWalletService.loadMore(view.address);
                }}
              >
                Load more
              </Button>
            )}
          </>
        }
      >
        {submissions.map(submission => (
          <BitcoinSubmissionListItem
            key={submission.txid}
            submission={submission}
            onClick={() => {
              if (!isViewActive()) return;
              route.transaction({txid: submission.txid}).$push();
            }}
          />
        ))}
        {transactions.map(transaction => (
          <BitcoinTransactionListItem
            key={transaction.txid}
            transaction={transaction}
            onClick={() => {
              if (!isViewActive()) return;
              route.transaction({txid: transaction.txid}).$push();
            }}
          />
        ))}
      </TransactionsPage>
    );
  },
);
