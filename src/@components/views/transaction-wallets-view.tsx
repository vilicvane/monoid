import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import type {EvmTransaction} from '../../@lib/evm-transaction.js';
import {normalizeWalletAddress} from '../../@lib/wallet-address.js';
import type {Router} from '../../@routes.js';
import {
  type SolanaTransactionHistoryItem,
  getKeyWallets,
} from '../../@services/index.js';
import {useSolanaTransactionConfirmation} from '../@hooks/use-solana-transaction-confirmation.js';
import {useTransactionConfirmation} from '../@hooks/use-transaction-confirmation.js';
import {WalletAccountList} from '../@key/wallet-account-list.js';
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

const SolanaTransactionConfirmation = observer(
  function SolanaTransactionConfirmation({
    transaction,
    active,
  }: {
    transaction: SolanaTransactionHistoryItem;
    active: boolean;
  }): ReactNode {
    useSolanaTransactionConfirmation(
      transaction.chainId,
      transaction.signature,
      active,
    );
    return null;
  },
);

export const TransactionWalletsView = observer(
  ({view}: RouteComponentProps<Router['transactions']>): ReactNode => {
    const {
      router,
      walletStorageService,
      transactionHistoryService,
      solanaTransactionHistoryService,
    } = useEntrances();
    const active = !view.$leaving && view.$match.$exact.$active;
    const wallets = new Map(
      walletStorageService.keys
        .flatMap(getKeyWallets)
        .flatMap(wallet =>
          wallet.addressType === 'evm' || wallet.addressType === 'solana'
            ? [
                [
                  normalizeWalletAddress(wallet.address),
                  wallet.addressType,
                ] as const,
              ]
            : [],
        ),
    );
    const pending = transactionHistoryService.pendingTransactions.filter(
      transaction =>
        wallets.get(normalizeWalletAddress(transaction.from)) === 'evm',
    );
    const solanaPending =
      solanaTransactionHistoryService.pendingTransactions.filter(
        transaction =>
          transaction.signature !== undefined &&
          wallets.get(transaction.address) === 'solana',
      );
    const solanaPendingTransactions = new Map(
      solanaPending.map(transaction => [
        `${transaction.chainId}:${transaction.signature}`,
        transaction,
      ]),
    );
    const counts = new Map<string, number>();
    for (const {from} of pending) {
      const address = normalizeWalletAddress(from);
      counts.set(address, (counts.get(address) ?? 0) + 1);
    }
    for (const {address} of solanaPending) {
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
        {Array.from(solanaPendingTransactions, ([key, transaction]) => (
          <SolanaTransactionConfirmation
            key={key}
            transaction={transaction}
            active={active}
          />
        ))}
        <ViewHeader>
          <ViewHeaderTitle>Transactions</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent>
          <WalletAccountList
            selectionLabel="Choose wallet"
            keys={walletStorageService.keys}
            addressType={['evm', 'solana']}
            renderStatus={addresses => {
              const count = addresses.reduce(
                (sum, address) =>
                  sum + (counts.get(normalizeWalletAddress(address)) ?? 0),
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
            onOpen={address =>
              router.transactions
                .wallet({
                  address,
                  addressType: wallets.get(normalizeWalletAddress(address))!,
                })
                .$push()
            }
          />
        </ViewContent>
      </View>
    );
  },
);
