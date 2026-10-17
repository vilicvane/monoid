import {styled} from 'styled-components';

export const NumberBadge = styled.span`
  box-sizing: border-box;
  display: inline-block;
  flex-shrink: 0;
  min-width: var(--number-badge-size, 16px);
  height: var(--number-badge-size, 16px);
  padding: 0 calc(var(--number-badge-size, 16px) / 4);
  border-radius: calc(var(--number-badge-size, 16px) / 2);
  background-color: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  font-size: var(--number-badge-font-size, 10px);
  font-weight: 600;
  line-height: var(--number-badge-size, 16px);
  font-variant-numeric: tabular-nums;
  text-align: center;
`;
