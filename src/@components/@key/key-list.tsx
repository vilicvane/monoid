import {styled} from 'styled-components';

import type {AddressChain} from '../../@lib/wallet-address.js';
import {Address, AddressPlaceholder} from '../@ui/address.js';

const ADDRESS_PLACEHOLDER_BACKGROUNDS: Record<AddressChain, string> = {
  evm: `linear-gradient(90deg,
    color-mix(in srgb, #627eea 20%, var(--ion-background-color, white)),
    color-mix(in srgb, #8c9bf1 20%, var(--ion-background-color, white)))`,
  solana: `linear-gradient(90deg,
    color-mix(in srgb, #9945ff 20%, var(--ion-background-color, white)),
    color-mix(in srgb, #14f195 20%, var(--ion-background-color, white)))`,
  bitcoin: `linear-gradient(90deg,
    color-mix(in srgb, #f7931a 20%, var(--ion-background-color, white)),
    color-mix(in srgb, #f7931a 10%, var(--ion-background-color, white)))`,
};

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

export const KeyListAddressPlaceholder = styled(AddressPlaceholder)<{
  $chain: AddressChain;
}>`
  &::before {
    background: ${({$chain}) => ADDRESS_PLACEHOLDER_BACKGROUNDS[$chain]};
  }
`;
