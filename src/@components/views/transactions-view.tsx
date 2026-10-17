import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import type {Router} from '../../@routes.js';
import {WalletAccountList} from '../@key/wallet-account-list.js';
import {InfoSection} from '../@ui/info-section.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  ViewPlaceholder,
} from '../@view/index.js';

import {
  TransactionList,
  TransactionListItem,
} from './@sessions/transaction-list.js';

export const TransactionsView = observer(
  ({
    view,
  }: RouteComponentProps<Router['transactions']['wallet']>): ReactNode => {
    const {router, walletStorageService, transactionHistoryService} =
      useEntrances();
    const active = !view.$leaving && view.$match.$exact.$active;
    const items = transactionHistoryService.list(view.address);

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Transactions</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent>
          <InfoSection>
            <WalletAccountList
              keys={walletStorageService.keys}
              addressType="evm"
              addresses={[view.address]}
              compact
              contained
            />
          </InfoSection>
          {items.length ? (
            <TransactionList>
              {items.map(transaction => (
                <TransactionListItem
                  key={`${transaction.chainId}:${transaction.hash}`}
                  transaction={transaction}
                  active={active}
                  onClick={() =>
                    router.transactions
                      .wallet({address: view.address})
                      .transaction({
                        chainId: `eip155:${transaction.chainId}`,
                        hash: transaction.hash,
                      })
                      .$push()
                  }
                />
              ))}
            </TransactionList>
          ) : (
            <ViewPlaceholder>No transactions submitted</ViewPlaceholder>
          )}
        </ViewContent>
      </View>
    );
  },
);
