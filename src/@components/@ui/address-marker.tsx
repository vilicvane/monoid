import type {LucideIcon} from 'lucide-react';
import {
  BadgeCheck as badgeCheck,
  CircleHelp as circleHelp,
  History as history,
  ShieldCheck as shieldCheck,
  ShieldX as shieldX,
  User as user,
  UserPen as userPen,
} from 'lucide-react';
import type {ReactNode} from 'react';
import {css, styled} from 'styled-components';

import type {AddressKind} from '../../@lib/address-status.js';
import type {AddressMark} from '../../@services/index.js';

import {AppIcon} from './app-icon.js';
import {inlineIconCSS} from './inline-icon.js';

const Marker = styled(AppIcon)<{$color?: string}>`
  ${inlineIconCSS}
  ${({$color}) =>
    $color &&
    css`
      color: ${$color};
    `}
`;

const markers: Record<
  AddressKind | AddressMark,
  {icon: LucideIcon; color?: string; label: string; description: string}
> = {
  signer: {
    icon: userPen,
    color: 'var(--color-address-primary, var(--ion-color-primary))',
    label: 'Signer',
    description: 'The account signing this message.',
  },
  own: {
    icon: user,
    color: 'var(--color-address-primary, var(--ion-color-primary))',
    label: 'Yours',
    description: 'Another account in your Safe.',
  },
  seen: {
    icon: history,
    color: 'var(--color-address-seen, var(--ion-color-medium-tint))',
    label: 'Seen before',
    description: 'Included in a message you previously signed.',
  },
  listed: {
    icon: badgeCheck,
    color: 'var(--color-address-safe, var(--ion-color-safe))',
    label: 'Listed token',
    description: 'Included in the Uniswap token list for this network.',
  },
  unknown: {
    icon: circleHelp,
    color: 'var(--color-address-warning)',
    label: 'New address',
    description:
      'Not yours and not included in a message you previously signed.',
  },
  trusted: {
    icon: shieldCheck,
    color: 'var(--color-address-safe, var(--ion-color-safe-shade))',
    label: 'Trusted',
    description: 'You marked this address as trusted.',
  },
  dangerous: {
    icon: shieldX,
    color: 'var(--color-address-danger)',
    label: 'Dangerous',
    description: 'You marked this address as dangerous.',
  },
};

export function getAddressMarkerLabel(
  kind: AddressKind,
  mark?: AddressMark,
): string {
  return markers[mark ?? kind].label;
}

export function AddressMarker({
  kind,
  mark,
}: {
  kind: AddressKind;
  mark?: AddressMark;
}): ReactNode {
  const {icon, color, label, description} = markers[mark ?? kind];

  return (
    <Marker icon={icon} $color={color} aria-label={label} title={description} />
  );
}
