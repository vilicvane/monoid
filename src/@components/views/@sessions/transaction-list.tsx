import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {TransactionHistoryItem} from '../../../@services/index.js';
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
    <Item>
      <Header>
        <ChainTag chainId={chainId} />
        <Metadata>
          <PopupDateTime value={transaction.timestamp} />
          <Status status={confirmation.status} />
        </Metadata>
      </Header>
      <HashButton
        type="button"
        className="ion-activatable"
        aria-label={`View transaction ${transaction.hash}`}
        onClick={onClick}
      >
        <EllipsisInMiddle>{transaction.hash}</EllipsisInMiddle>
        <RippleEffect />
      </HashButton>
    </Item>
  );
});
