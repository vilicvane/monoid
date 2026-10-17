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

export const KeyList = styled.div<{
  $compact?: boolean;
  $compactContent?: boolean;
  $contained?: boolean;
}>`
  --key-list-item-padding-block: ${props =>
    props.$compact ? (props.$contained ? 0 : 4) : 12}px;
  --key-list-item-padding-inline: ${props =>
    props.$contained
      ? 'calc(-1 * var(--tag-inline-margin))'
      : 'var(--view-padding)'};
  --key-list-item-content-gap: ${props => (props.$compactContent ? 4 : 8)}px;

  flex: 1;
  margin: 0 calc(-1 * var(--key-list-item-padding-inline));
`;

export const KeyListItem = styled.div`
  position: relative;
  display: flex;

  align-items: flex-start;
  justify-content: space-between;
  gap: var(--key-item-gap);

  padding: var(--key-list-item-padding-block, 12px)
    var(--key-list-item-padding-inline, var(--view-padding));

  overflow: hidden;
`;

export const KeyListItemContent = styled.div`
  flex: 1;
  min-width: 0;
  align-self: center;

  display: flex;
  flex-direction: column;
  gap: var(--key-list-item-content-gap, 8px);
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
