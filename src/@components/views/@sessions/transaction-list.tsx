import type {ComponentProps, ReactNode} from 'react';
import {styled} from 'styled-components';

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

export function TransactionListMetadata({
  time,
  status,
}: {
  time: number | string;
  status: ComponentProps<typeof TransactionStatus>['status'];
}): ReactNode {
  return (
    <>
      {typeof time === 'number' ? (
        <PopupDateTime value={time} />
      ) : (
        <span>{time}</span>
      )}
      <Status status={status} />
    </>
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
