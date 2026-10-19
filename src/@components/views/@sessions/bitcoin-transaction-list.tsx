import type {ReactNode} from 'react';

import type {
  BitcoinSubmission,
  BitcoinWalletTransaction,
} from '../../../@services/index.js';
import {AddressChainIcon} from '../../@key/address-chain-icon.js';
import {IconTag, IconTagName} from '../../@ui/icon-tag.js';

import {
  TransactionListMetadata,
  TransactionListRow,
} from './transaction-list.js';

const chain = (
  <IconTag>
    <AddressChainIcon chain="bitcoin" />
    <IconTagName>Bitcoin</IconTagName>
  </IconTag>
);

export function BitcoinTransactionListItem({
  transaction,
  onClick,
}: {
  transaction: BitcoinWalletTransaction;
  onClick: () => void;
}): ReactNode {
  return (
    <TransactionListRow
      chain={chain}
      hash={transaction.txid}
      metadata={
        <TransactionListMetadata
          time={
            transaction.status.confirmed
              ? transaction.status.blockTime * 1000
              : 'Pending'
          }
          status={transaction.status.confirmed ? 'confirmed' : 'pending'}
        />
      }
      onClick={onClick}
    />
  );
}

export function BitcoinSubmissionListItem({
  submission,
  onClick,
}: {
  submission: BitcoinSubmission;
  onClick: () => void;
}): ReactNode {
  return (
    <TransactionListRow
      chain={chain}
      hash={submission.txid}
      metadata={
        submission.status === 'unknown' ? (
          <span role="status">Broadcast unconfirmed</span>
        ) : (
          <TransactionListMetadata
            time={submission.createdAt}
            status={
              submission.status === 'submitted'
                ? 'pending'
                : submission.status === 'rejected'
                  ? 'failed'
                  : submission.status
            }
          />
        )
      }
      onClick={onClick}
    />
  );
}
