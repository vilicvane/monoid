import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import type {EvmTransaction} from '../../@lib/evm-transaction.js';
import {normalizeWalletAddress} from '../../@lib/wallet-address.js';
import type {Router} from '../../@routes.js';
import {getKeyWallets} from '../../@services/index.js';
import {useTransactionConfirmation} from '../@hooks/use-transaction-confirmation.js';
import {useViewActive} from '../@view/index.js';

import {WalletsView} from './wallets-view.js';

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

export const EthereumWalletsView = observer(
  ({view}: RouteComponentProps<Router['ethereum']>): ReactNode => {
    const {router, walletStorageService, transactionHistoryService} =
      useEntrances();
    const isViewActive = useViewActive(view);
    const active = isViewActive();
    const addresses = new Set(
      walletStorageService.keys
        .flatMap(getKeyWallets)
        .filter(wallet => wallet.addressType === 'evm')
        .map(wallet => normalizeWalletAddress(wallet.address)),
    );
    const pending = transactionHistoryService.pendingTransactions.filter(
      transaction => addresses.has(normalizeWalletAddress(transaction.from)),
    );
    const counts = new Map<string, number>();
    for (const {from} of pending) {
      const address = normalizeWalletAddress(from);
      counts.set(address, (counts.get(address) ?? 0) + 1);
    }

    return (
      <WalletsView
        title="Ethereum"
        active={active}
        keys={walletStorageService.keys}
        addressType="evm"
        pendingCounts={counts}
        onOpen={address => {
          if (!isViewActive()) return;
          router.ethereum.wallet({address}).$push();
        }}
      >
        {pending.map(transaction => (
          <TransactionConfirmation
            key={`${transaction.chainId}:${transaction.hash}`}
            transaction={transaction}
            active={active}
          />
        ))}
      </WalletsView>
    );
  },
);
