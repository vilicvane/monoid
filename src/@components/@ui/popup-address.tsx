import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {
  type AddressKind,
  getAddressSeverity,
} from '../../@lib/address-status.js';
import type {AddressMark} from '../../@services/index.js';

import {ExpandableAddress} from './expandable-address.js';
import {MessageContent} from './message-content.js';

const Address = styled(MessageContent)<{$severity?: 'warning' | 'danger'}>`
  --color-text-emphasis: ${({$severity}) =>
    $severity ? `var(--color-address-${$severity})` : 'white'};

  margin: 0;
  padding: 0;
  background: transparent;
  color: ${({$severity}) =>
    $severity
      ? `var(--color-address-${$severity})`
      : 'rgba(255, 255, 255, 0.65)'};

  &[aria-expanded='true'] {
    color: var(--color-text-emphasis);
  }
`;

export function PopupAddress({
  children,
  className,
  onClick,
  kind,
  mark,
}: {
  children: string;
  className?: string;
  onClick?: () => void;
  kind?: AddressKind;
  mark?: AddressMark;
}): ReactNode {
  return (
    <Address
      as={ExpandableAddress}
      highlightEdges
      className={className}
      onClick={onClick}
      kind={kind}
      mark={mark}
      $severity={getAddressSeverity(kind, mark)}
    >
      {children}
    </Address>
  );
}

export const CenteredPopupAddress = styled(PopupAddress)`
  --ellipsis-alignment: center;
  text-align: center;
`;
