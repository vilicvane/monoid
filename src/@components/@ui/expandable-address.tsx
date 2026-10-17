import {type ReactNode, useMemo, useState} from 'react';
import {styled} from 'styled-components';

import {
  type AddressKind,
  getAddressSeverity,
} from '../../@lib/address-status.js';
import type {AddressMark} from '../../@services/index.js';

import {AddressMarker, getAddressMarkerLabel} from './address-marker.js';
import {EllipsisInMiddle} from './ellipsis-in-middle.js';
import type {HighlightRange} from './highlighted-text.js';
import {inlineIconRowCSS} from './inline-icon.js';

const Container = styled.button<{$severity?: 'warning' | 'danger'}>`
  ${inlineIconRowCSS}
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
  highlightEdges = false,
  className,
}: {
  children: string;
  kind?: AddressKind;
  mark?: AddressMark;
  onClick?: () => void;
  highlightEdges?: boolean;
  className?: string;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const highlightRanges = useMemo<readonly HighlightRange[] | undefined>(() => {
    if (!highlightEdges) return undefined;

    const start = address.startsWith('0x') ? 2 : 0;

    return [
      [start, start + 8],
      [address.length - 8, address.length],
    ];
  }, [address, highlightEdges]);

  return (
    <Container
      type="button"
      className={className}
      $severity={kind ? getAddressSeverity(kind, mark) : undefined}
      aria-label={
        kind ? `${address}, ${getAddressMarkerLabel(kind, mark)}` : address
      }
      aria-expanded={onClick ? undefined : expanded}
      onClick={onClick ?? (() => setExpanded(!expanded))}
    >
      <Value>
        {expanded ? (
          address
        ) : (
          <EllipsisInMiddle highlightRanges={highlightRanges}>
            {address}
          </EllipsisInMiddle>
        )}
      </Value>
      {kind && <AddressMarker kind={kind} mark={mark} />}
    </Container>
  );
}
