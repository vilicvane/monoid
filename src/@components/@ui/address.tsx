import {css, styled} from 'styled-components';

import {EllipsisInMiddle} from './ellipsis-in-middle.js';

const addressTextStyles = css`
  font-size: 16px;
  line-height: 21px;
`;

export const Address = styled(EllipsisInMiddle)`
  ${addressTextStyles}
`;

export const AddressPlaceholder = styled.div`
  ${addressTextStyles}

  height: 1lh;
  display: flex;
  align-items: center;

  &::before {
    content: '';
    flex: 1;
    margin: 0 -1px;
    height: 12px;
    border-radius: 999px;
    background: var(--ion-color-light-shade);
  }
`;
