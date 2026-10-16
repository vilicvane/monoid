import {type ReactNode, useState} from 'react';
import {styled} from 'styled-components';

import {
  type AddressKind,
  getAddressSeverity,
} from '../../@lib/address-status.js';
import type {AddressMark} from '../../@services/index.js';

import {AddressMarker, getAddressMarkerLabel} from './address-marker.js';
import {EllipsisInMiddle} from './ellipsis-in-middle.js';

const Container = styled.button<{$severity?: 'warning' | 'danger'}>`
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: ${({$severity}) =>
    $severity ? `var(--color-address-${$severity})` : 'inherit'};
  font: inherit;
  text-align: left;
  overflow-wrap: anywhere;
  user-select: text;
`;

const Value = styled.span`
  flex: 1;
  min-width: 0;
`;

export function ExpandableAddress({
  children: address,
  kind,
  mark,
  onClick,
}: {
  children: string;
  kind?: AddressKind;
  mark?: AddressMark;
  onClick?: () => void;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);

  return (
    <Container
      type="button"
      $severity={kind ? getAddressSeverity(kind, mark) : undefined}
      aria-label={
        kind ? `${address}, ${getAddressMarkerLabel(kind, mark)}` : address
      }
      aria-expanded={onClick ? undefined : expanded}
      onClick={onClick ?? (() => setExpanded(!expanded))}
    >
      <Value>
        {expanded ? address : <EllipsisInMiddle>{address}</EllipsisInMiddle>}
      </Value>
      {kind && <AddressMarker kind={kind} mark={mark} />}
    </Container>
  );
}
