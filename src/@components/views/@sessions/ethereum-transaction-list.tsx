import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import type {TransactionHistoryItem} from '../../../@services/index.js';
import {useTransactionConfirmation} from '../../@hooks/use-transaction-confirmation.js';
import {ChainTag} from '../../@ui/chain-name.js';

import {
  TransactionListMetadata,
  TransactionListRow,
} from './transaction-list.js';

export const EthereumTransactionListItem = observer(
  function EthereumTransactionListItem({
    transaction,
    active,
    onClick,
  }: {
    transaction: TransactionHistoryItem;
    active: boolean;
    onClick: () => void;
  }): ReactNode {
    const confirmation = useTransactionConfirmation(transaction, active);

    return (
      <TransactionListRow
        chain={<ChainTag chainId={`eip155:${transaction.chainId}`} />}
        hash={transaction.hash}
        metadata={
          <TransactionListMetadata
            time={transaction.timestamp}
            status={confirmation.status}
          />
        }
        onClick={onClick}
      />
    );
  },
);
