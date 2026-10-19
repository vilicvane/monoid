import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import type {Router} from '../../@routes.js';
import {
  type SolanaTransactionHistoryItem,
  getKeyWallets,
} from '../../@services/index.js';
import {useSolanaTransactionConfirmation} from '../@hooks/use-solana-transaction-confirmation.js';
import {useViewActive} from '../@view/index.js';

import {WalletsView} from './wallets-view.js';

const TransactionConfirmation = observer(function TransactionConfirmation({
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
});

export const SolanaWalletsView = observer(
  ({view}: RouteComponentProps<Router['solana']>): ReactNode => {
    const {router, walletStorageService, solanaTransactionHistoryService} =
      useEntrances();
    const isViewActive = useViewActive(view);
    const active = isViewActive();
    const addresses = new Set(
      walletStorageService.keys
        .flatMap(getKeyWallets)
        .filter(wallet => wallet.addressType === 'solana')
        .map(wallet => wallet.address),
    );
    const pending = solanaTransactionHistoryService.pendingTransactions.filter(
      transaction =>
        transaction.signature !== undefined &&
        addresses.has(transaction.address),
    );
    const confirmations = new Map(
      pending.map(transaction => [
        `${transaction.chainId}:${transaction.signature}`,
        transaction,
      ]),
    );
    const counts = new Map<string, number>();
    for (const {address} of pending) {
      counts.set(address, (counts.get(address) ?? 0) + 1);
    }

    return (
      <WalletsView
        title="Solana"
        active={active}
        keys={walletStorageService.keys}
        addressType="solana"
        pendingCounts={counts}
        onOpen={address => {
          if (!isViewActive()) return;
          router.solana.wallet({address}).$push();
        }}
      >
        {Array.from(confirmations, ([key, transaction]) => (
          <TransactionConfirmation
            key={key}
            transaction={transaction}
            active={active}
          />
        ))}
      </WalletsView>
    );
  },
);
