import {styled} from 'styled-components';

import {Address} from '../@ui/address.js';

export const KeyList = styled.div`
  flex: 1;
  margin: 0 calc(-1 * var(--view-padding));
`;

export const KeyListItem = styled.div`
  position: relative;
  display: flex;

  align-items: center;
  justify-content: space-between;
  gap: 8px;

  padding: 12px var(--view-padding);

  overflow: hidden;
`;

export const KeyListItemContent = styled.div`
  flex: 1;
  min-width: 0;

  display: flex;
  flex-direction: column;
  gap: 8px;
`;

export const KeyListAddress = styled(Address)`
  color: var(--ion-color-dark);
`;

export const KeyListPlaceholder = styled.div`
  color: var(--ion-color-medium);
  font-size: 14px;
  line-height: 21px;
`;
