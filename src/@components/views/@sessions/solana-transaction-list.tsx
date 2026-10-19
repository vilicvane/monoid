import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import type {SolanaTransactionHistoryItem} from '../../../@services/index.js';
import {useSolanaTransactionConfirmation} from '../../@hooks/use-solana-transaction-confirmation.js';
import {ChainTag} from '../../@ui/chain-name.js';

import {
  TransactionListMetadata,
  TransactionListRow,
} from './transaction-list.js';

export const SolanaTransactionListItem = observer(
  function SolanaTransactionListItem({
    transaction,
    active,
    onClick,
  }: {
    transaction: SolanaTransactionHistoryItem;
    active: boolean;
    onClick: () => void;
  }): ReactNode {
    const confirmation = useSolanaTransactionConfirmation(
      transaction.chainId,
      transaction.signature,
      active,
    );

    return (
      <TransactionListRow
        chain={<ChainTag chainId={transaction.chainId} />}
        hash={transaction.signature}
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
