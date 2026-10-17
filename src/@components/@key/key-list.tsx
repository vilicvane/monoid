import {styled} from 'styled-components';

import type {AddressChain} from '../../@lib/wallet-address.js';
import {Address, AddressPlaceholder} from '../@ui/address.js';
import {List, ListItem, ListItemContent} from '../@ui/list.js';

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

export const KeyList = styled(List)<{
  $compact?: boolean;
  $compactContent?: boolean;
  $contained?: boolean;
}>`
  --list-item-padding-block: ${props =>
    props.$compact ? (props.$contained ? 0 : 4) : 8}px;
  --list-item-padding-inline: ${props =>
    props.$contained
      ? 'calc(-1 * var(--tag-inline-margin))'
      : 'var(--view-padding)'};
  --list-item-content-gap: ${props => (props.$compactContent ? 4 : 8)}px;
`;

export const KeyListItem = styled(ListItem)`
  gap: var(--key-item-gap);
`;

export const KeyListItemContent = ListItemContent;

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
