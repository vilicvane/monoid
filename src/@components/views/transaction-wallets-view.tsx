import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import type {EvmTransaction} from '../../@lib/evm-transaction.js';
import type {Router} from '../../@routes.js';
import {getKeyWallets} from '../../@services/index.js';
import {useTransactionConfirmation} from '../@hooks/use-transaction-confirmation.js';
import {WalletAccountList} from '../@key/wallet-account-list.js';
import {InfoSectionItemLabel} from '../@ui/info-section.js';
import {LoadingSpinner} from '../@ui/loading-spinner.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../@view/index.js';

const PendingTransactions = styled.span`
  display: inline-flex;
  align-items: center;
  align-self: center;
  flex-shrink: 0;
  order: 2;
  margin-left: auto;
  font-size: 16px;
  color: var(--ion-color-primary);
`;

const TransactionConfirmation = observer(function TransactionConfirmation({
  transaction,
  active,
}: {
  transaction: EvmTransaction;
  active: boolean;
}): ReactNode {
  useTransactionConfirmation(transaction, active);
  return null;
});

export const TransactionWalletsView = observer(
  ({view}: RouteComponentProps<Router['transactions']>): ReactNode => {
    const {router, walletStorageService, transactionHistoryService} =
      useEntrances();
    const active = !view.$leaving && view.$match.$exact.$active;
    const wallets = new Set(
      walletStorageService.keys
        .flatMap(getKeyWallets)
        .filter(wallet => wallet.addressType === 'evm')
        .map(wallet => wallet.address.toLowerCase()),
    );
    const pending = transactionHistoryService.pendingTransactions.filter(
      transaction => wallets.has(transaction.from.toLowerCase()),
    );
    const counts = new Map<string, number>();
    for (const {from} of pending) {
      const address = from.toLowerCase();
      counts.set(address, (counts.get(address) ?? 0) + 1);
    }

    return (
      <View inert={!active}>
        {pending.map(transaction => (
          <TransactionConfirmation
            key={`${transaction.chainId}:${transaction.hash}`}
            transaction={transaction}
            active={active}
          />
        ))}
        <ViewHeader>
          <ViewHeaderTitle>Transactions</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent>
          <InfoSectionItemLabel>Choose wallet</InfoSectionItemLabel>
          <WalletAccountList
            keys={walletStorageService.keys}
            addressType="evm"
            renderStatus={addresses => {
              const count = addresses.reduce(
                (sum, address) =>
                  sum + (counts.get(address.toLowerCase()) ?? 0),
                0,
              );
              if (!count) return null;

              const label = `${count} pending transaction${count === 1 ? '' : 's'}`;
              return (
                <PendingTransactions
                  role="status"
                  aria-label={label}
                  title={label}
                >
                  <LoadingSpinner />
                </PendingTransactions>
              );
            }}
            onOpen={address => router.transactions.wallet({address}).$push()}
          />
        </ViewContent>
      </View>
    );
  },
);
