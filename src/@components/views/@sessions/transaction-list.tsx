import {observer} from 'mobx-react-lite';
import type {ComponentProps, ReactNode} from 'react';
import {styled} from 'styled-components';

import type {
  SolanaTransactionHistoryItem,
  TransactionHistoryItem,
} from '../../../@services/index.js';
import {useSolanaTransactionConfirmation} from '../../@hooks/use-solana-transaction-confirmation.js';
import {useTransactionConfirmation} from '../../@hooks/use-transaction-confirmation.js';
import {ChainTag} from '../../@ui/chain-name.js';
import {PopupDateTime} from '../../@ui/date-time.js';
import {EllipsisInMiddle} from '../../@ui/ellipsis-in-middle.js';
import {RippleEffect} from '../../@ui/ripple-effect.js';
import {TransactionStatus} from '../../@ui/transaction-status.js';

export const TransactionList = styled.div`
  margin: 0 calc(-1 * var(--view-padding));
`;

const Item = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  padding: 8px var(--view-padding);
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;

  button {
    position: relative;
    z-index: 1;
  }
`;

const Metadata = styled.div`
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 18px;
  white-space: nowrap;
`;

const HashButton = styled.button`
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: 14px;
  text-align: left;

  &::after {
    content: '';
    position: absolute;
    inset: 0;
    cursor: pointer;
  }

  &:focus-visible {
    outline: none;
  }

  &:focus-visible::after {
    outline: 2px solid var(--ion-color-primary);
    outline-offset: -2px;
  }
`;

const Status = styled(TransactionStatus)`
  font-size: 16px;
`;

export const TransactionListItem = observer(function TransactionListItem({
  transaction,
  active,
  onClick,
}: {
  transaction: TransactionHistoryItem;
  active: boolean;
  onClick: () => void;
}): ReactNode {
  const chainId = `eip155:${transaction.chainId}`;
  const confirmation = useTransactionConfirmation(transaction, active);

  return (
    <TransactionItem
      chainId={chainId}
      hash={transaction.hash}
      timestamp={transaction.timestamp}
      status={confirmation.status}
      onClick={onClick}
    />
  );
});

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
      <TransactionItem
        chainId={transaction.chainId}
        hash={transaction.signature}
        timestamp={transaction.timestamp}
        status={confirmation.status}
        onClick={onClick}
      />
    );
  },
);

function TransactionItem({
  chainId,
  hash,
  timestamp,
  status,
  onClick,
}: {
  chainId: string;
  hash?: string;
  timestamp: number;
  status: ComponentProps<typeof TransactionStatus>['status'];
  onClick: () => void;
}): ReactNode {
  return (
    <TransactionListRow
      chain={<ChainTag chainId={chainId} />}
      metadata={
        <>
          <PopupDateTime value={timestamp} />
          <Status status={status} />
        </>
      }
      hash={hash}
      onClick={onClick}
    />
  );
}

export function TransactionListRow({
  chain,
  metadata,
  hash,
  onClick,
}: {
  chain: ReactNode;
  metadata: ReactNode;
  hash?: string;
  onClick: () => void;
}): ReactNode {
  return (
    <Item>
      <Header>
        {chain}
        <Metadata>{metadata}</Metadata>
      </Header>
      <HashButton
        type="button"
        className="ion-activatable"
        aria-label={
          hash ? `View transaction ${hash}` : 'View signed transaction'
        }
        onClick={onClick}
      >
        {hash ? (
          <EllipsisInMiddle>{hash}</EllipsisInMiddle>
        ) : (
          'Signed transaction'
        )}
        <RippleEffect />
      </HashButton>
    </Item>
  );
}
