import {styled} from 'styled-components';

import {TAG_HEIGHT, Tag} from './tag.js';

export const InfoSection = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;

  & + & {
    margin-top: calc(var(--view-section-gap, 16px) - 8px);
  }
`;

export const InfoSectionTitle = styled.div``;

export const InfoFieldset = styled(InfoSection).attrs({as: 'fieldset'})<{
  $equalPadding?: boolean;
}>`
  --info-fieldset-border-width: 0.5px;
  --info-fieldset-padding: 12px;
  --info-fieldset-label-inset: 6px;
  --info-fieldset-title-overlap: ${TAG_HEIGHT / 2}px;

  position: relative;
  min-width: 0;
  margin: 0 -2px;
  padding: var(--info-fieldset-padding);
  padding-top: ${props =>
    props.$equalPadding
      ? 'calc(var(--info-fieldset-padding) + var(--info-fieldset-border-width) - var(--info-fieldset-title-overlap))'
      : '6px'};
  border: solid var(--info-fieldset-border-width) transparent;

  &::before {
    content: '';
    position: absolute;
    /* A fieldset's positioning area starts below its legend. */
    top: calc(-1 * var(--info-fieldset-title-overlap));
    right: calc(-1 * var(--info-fieldset-border-width));
    bottom: calc(-1 * var(--info-fieldset-border-width));
    left: calc(-1 * var(--info-fieldset-border-width));
    border: solid var(--info-fieldset-border-width) var(--ion-color-light-shade);
    border-radius: var(--info-border-radius);
    pointer-events: none;
  }
`;

export const InfoLegend = styled(Tag).attrs({as: 'legend'})`
  position: relative;
  z-index: 1;
  max-width: 100%;
  margin-left: calc(
    var(--info-fieldset-label-inset) - var(--info-fieldset-padding) - var(
        --info-fieldset-border-width
      )
  );
  background-color: var(--ion-color-dark);
  border-color: var(--ion-color-dark-shade);
  color: var(--ion-color-dark-contrast);
`;

export const InfoSectionHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;

  > button:last-child {
    /* Keep the icon button's hit area from increasing the title row height. */
    margin-top: -5px;
    margin-right: -8px;
    margin-bottom: -5px;
  }
`;

export const InfoSectionItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

export const InfoSectionItemLabel = styled.div`
  font-size: 14px;
  color: var(--color-text-label, var(--ion-color-medium));
`;

export const InfoSectionItemContent = styled.div`
  max-width: 100%;
  overflow-wrap: anywhere;
`;

export const InfoFieldsetValue = styled(InfoSectionItemContent)`
  font-size: 24px;
  text-align: center;
`;

export const InfoSectionRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 16px;
  font-size: 14px;

  > :last-child {
    margin-left: auto;
    text-align: right;
  }
`;

export const InfoTable = styled.table`
  width: calc(100% + 4px);
  margin: 0 -2px;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
  border: solid 0.5px var(--ion-color-light-shade);
  border-radius: var(--info-border-radius);
  overflow: hidden;
  background: white;
  font-size: 14px;
  line-height: 1.5;

  th,
  td {
    padding: 4px 10px;
    vertical-align: baseline;
    overflow-wrap: anywhere;
  }

  tr:first-child > * {
    padding-top: 8px;
  }

  tr:last-child > * {
    padding-bottom: 8px;
  }

  th {
    width: 55%;
    font-weight: normal;
    text-align: left;
    color: var(--color-text-label, var(--ion-color-medium));
  }

  td {
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  tfoot td {
    font-size: 12px;
    text-align: left;
    color: var(--color-text-label, var(--ion-color-medium));
  }
`;

export const InfoTableSummary = styled.tr`
  th {
    color: var(--ion-color-medium-shade);
  }

  td {
    font-size: 16px;
  }
`;
