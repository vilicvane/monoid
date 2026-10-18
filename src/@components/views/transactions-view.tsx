import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import type {Router} from '../../@routes.js';
import {WalletAccountList} from '../@key/wallet-account-list.js';
import {InfoSection, InfoSectionItemLabel} from '../@ui/info-section.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  ViewPlaceholder,
} from '../@view/index.js';

import {
  SolanaTransactionListItem,
  TransactionList,
  TransactionListItem,
} from './@sessions/transaction-list.js';

export const TransactionsView = observer(
  ({
    view,
  }: RouteComponentProps<Router['transactions']['wallet']>): ReactNode => {
    const {
      router,
      walletStorageService,
      transactionHistoryService,
      solanaTransactionHistoryService,
    } = useEntrances();
    const active = !view.$leaving && view.$match.$exact.$active;
    const evmItems =
      view.addressType === 'evm'
        ? transactionHistoryService.list(view.address)
        : [];
    const solanaItems =
      view.addressType === 'solana'
        ? solanaTransactionHistoryService.list(view.address)
        : [];
    const hasTransactions = evmItems.length > 0 || solanaItems.length > 0;
    const wallet = router.transactions.wallet({
      address: view.address,
      addressType: view.addressType,
    });

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Transactions</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent>
          <InfoSection>
            <WalletAccountList
              keys={walletStorageService.keys}
              addressType={view.addressType}
              addresses={[view.address]}
              compact
              contained
            />
          </InfoSection>
          {hasTransactions && (
            <InfoSectionItemLabel>Choose transaction</InfoSectionItemLabel>
          )}
          {hasTransactions ? (
            <TransactionList>
              {evmItems.map(transaction => (
                <TransactionListItem
                  key={`${transaction.chainId}:${transaction.hash}`}
                  transaction={transaction}
                  active={active}
                  onClick={() =>
                    wallet
                      .transaction({
                        chainId: `eip155:${transaction.chainId}`,
                        hash: transaction.hash,
                      })
                      .$push()
                  }
                />
              ))}
              {solanaItems.map(transaction => (
                <SolanaTransactionListItem
                  key={`${transaction.chainId}:${transaction.id}`}
                  transaction={transaction}
                  active={active}
                  onClick={() =>
                    wallet
                      .solanaTransaction({
                        chainId: transaction.chainId,
                        id: transaction.id,
                      })
                      .$push()
                  }
                />
              ))}
            </TransactionList>
          ) : (
            <ViewPlaceholder>
              {view.addressType === 'solana'
                ? 'No transactions'
                : 'No transactions submitted'}
            </ViewPlaceholder>
          )}
        </ViewContent>
      </View>
    );
  },
);
