import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {
  type AddressKind,
  getAddressSeverity,
} from '../../@lib/address-status.js';
import type {AddressMark} from '../../@services/index.js';

import {ExpandableAddress} from './expandable-address.js';
import {MessageContent} from './message-content.js';

const Address = styled(MessageContent)<{
  $severity?: 'warning' | 'danger';
  $highlightEdges: boolean;
}>`
  --color-text-emphasis: ${({$severity}) =>
    $severity ? `var(--color-address-${$severity})` : 'white'};

  margin: 0;
  padding: 0;
  background: transparent;
  color: ${({$severity, $highlightEdges}) =>
    $severity
      ? `var(--color-address-${$severity})`
      : $highlightEdges
        ? 'rgba(255, 255, 255, 0.65)'
        : 'white'};

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
  highlightEdges = false,
}: {
  children: string;
  className?: string;
  onClick?: () => void;
  kind?: AddressKind;
  mark?: AddressMark;
  highlightEdges?: boolean;
}): ReactNode {
  return (
    <Address
      as={ExpandableAddress}
      highlightEdges={highlightEdges}
      $highlightEdges={highlightEdges}
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
