import {styled} from 'styled-components';

import {DetailsPopupSection} from './details-popup.js';
import {IconButton} from './icon-button.js';
import {InfoSectionHeader, InfoSectionRow, InfoTable} from './info-section.js';
import {inlineIconCSS} from './inline-icon.js';

export const TokenActivityDetailsButton = styled(IconButton)`
  ${inlineIconCSS}
`;

export const TokenChangesTable = styled(InfoTable)`
  width: 100%;
  margin: 0;
  border: 0;
  border-radius: 0;
  overflow: visible;
  background: transparent;

  td {
    padding-inline: 0;
  }

  tr:first-child > * {
    padding-top: 4px;
  }

  tr:last-child > * {
    padding-bottom: 4px;
  }
`;

export const TokenChange = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-width: 0;
  text-align: left;
`;

export const TokenActivityAmount = styled.span<{$change?: bigint}>`
  flex-shrink: 0;
  max-width: 100%;
  margin-left: auto;
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  color: ${({$change}) =>
    $change !== undefined && $change > BigInt(0)
      ? 'var(--ion-color-safe-shade)'
      : $change !== undefined && $change < BigInt(0)
        ? 'var(--color-text-danger)'
        : 'inherit'};
`;

export const TokenChangeAmount = styled(TokenActivityAmount)`
  font-size: 18px;
`;

export const TokenActivity = styled(DetailsPopupSection)`
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 8px 12px;
`;

export const TokenActivityHeader = styled(InfoSectionHeader)`
  grid-column: 1 / -1;
  font-size: 14px;
`;

export const TokenActivitySummary = styled(TokenChange).attrs({as: 'button'})`
  grid-column: 1 / -1;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
`;

export const TokenActivityAddress = styled(InfoSectionRow)`
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  align-items: baseline;
  gap: inherit;

  > :last-child {
    min-width: 0;
    margin-left: 0;
    text-align: left;
  }
`;
