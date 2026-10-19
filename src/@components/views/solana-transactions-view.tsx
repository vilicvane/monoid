import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import type {Router} from '../../@routes.js';
import {useViewActive} from '../@view/index.js';

import {SolanaTransactionListItem} from './@sessions/solana-transaction-list.js';
import {TransactionsPage} from './@transactions/transactions-page.js';

export const SolanaTransactionsView = observer(
  ({view}: RouteComponentProps<Router['solana']['wallet']>): ReactNode => {
    const {router, walletStorageService, solanaTransactionHistoryService} =
      useEntrances();
    const isViewActive = useViewActive(view);
    const active = isViewActive();
    const transactions = solanaTransactionHistoryService.list(view.address);
    const wallet = router.solana.wallet({address: view.address});

    return (
      <TransactionsPage
        active={active}
        keys={walletStorageService.keys}
        account={{address: view.address, addressType: 'solana'}}
        hasTransactions={transactions.length > 0}
      >
        {transactions.map(transaction => (
          <SolanaTransactionListItem
            key={`${transaction.chainId}:${transaction.id}`}
            transaction={transaction}
            active={active}
            onClick={() => {
              if (!isViewActive()) return;
              wallet
                .transaction({
                  chainId: transaction.chainId,
                  id: transaction.id,
                })
                .$push();
            }}
          />
        ))}
      </TransactionsPage>
    );
  },
);
