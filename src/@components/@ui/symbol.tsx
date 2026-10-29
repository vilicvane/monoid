import {styled} from 'styled-components';

import {LIST_ICON_SIZE} from './list.js';

export const Symbol = styled.span`
  width: ${LIST_ICON_SIZE}px;
  height: ${LIST_ICON_SIZE}px;
  border-radius: ${LIST_ICON_SIZE / 4}px;
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 28px;
`;
