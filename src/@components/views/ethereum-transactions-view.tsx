import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import type {Router} from '../../@routes.js';
import {useViewActive} from '../@view/index.js';

import {EthereumTransactionListItem} from './@sessions/ethereum-transaction-list.js';
import {TransactionsPage} from './@transactions/transactions-page.js';

export const EthereumTransactionsView = observer(
  ({view}: RouteComponentProps<Router['ethereum']['wallet']>): ReactNode => {
    const {router, walletStorageService, transactionHistoryService} =
      useEntrances();
    const isViewActive = useViewActive(view);
    const active = isViewActive();
    const transactions = transactionHistoryService.list(view.address);
    const wallet = router.ethereum.wallet({address: view.address});

    return (
      <TransactionsPage
        active={active}
        keys={walletStorageService.keys}
        account={{address: view.address, addressType: 'evm'}}
        hasTransactions={transactions.length > 0}
        emptyMessage="No transactions submitted"
      >
        {transactions.map(transaction => (
          <EthereumTransactionListItem
            key={`${transaction.chainId}:${transaction.hash}`}
            transaction={transaction}
            active={active}
            onClick={() => {
              if (!isViewActive()) return;
              wallet
                .transaction({
                  chainId: `eip155:${transaction.chainId}`,
                  hash: transaction.hash,
                })
                .$push();
            }}
          />
        ))}
      </TransactionsPage>
    );
  },
);
