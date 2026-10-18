import {styled} from 'styled-components';

import {DetailsPopupTitle} from './details-popup.js';
import {TokenLogo} from './token-logo.js';

export const TokenLabel = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: 16px;
  text-align: left;

  > ${TokenLogo} {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
  }
`;

export const TokenLabelName = styled(DetailsPopupTitle).attrs({as: 'span'})<{
  $color?: string;
}>`
  font: inherit;
  text-align: inherit;
  color: ${({$color}) => $color ?? 'inherit'};
`;
