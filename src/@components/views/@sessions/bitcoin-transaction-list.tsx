import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {
  BitcoinSubmission,
  BitcoinWalletTransaction,
} from '../../../@services/index.js';
import {AddressChainIcon} from '../../@key/address-chain-icon.js';
import {PopupDateTime} from '../../@ui/date-time.js';
import {IconTag, IconTagName} from '../../@ui/icon-tag.js';
import {TransactionStatus} from '../../@ui/transaction-status.js';

import {TransactionListRow} from './transaction-list.js';

const Status = styled(TransactionStatus)`
  font-size: 16px;
`;

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
        <>
          {transaction.status.confirmed ? (
            <PopupDateTime value={transaction.status.blockTime * 1000} />
          ) : (
            <span>Pending</span>
          )}
          <Status
            status={transaction.status.confirmed ? 'confirmed' : 'pending'}
          />
        </>
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
          <>
            <PopupDateTime value={submission.createdAt} />
            <Status
              status={
                submission.status === 'submitted'
                  ? 'pending'
                  : submission.status === 'rejected'
                    ? 'failed'
                    : submission.status
              }
            />
          </>
        )
      }
      onClick={onClick}
    />
  );
}
