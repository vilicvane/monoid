import {IonIcon} from '@ionic/react';
import circleHelp from 'lucide-static/icons/circle-help.svg';
import history from 'lucide-static/icons/history.svg';
import shieldCheck from 'lucide-static/icons/shield-check.svg';
import shieldX from 'lucide-static/icons/shield-x.svg';
import userPen from 'lucide-static/icons/user-pen.svg';
import user from 'lucide-static/icons/user.svg';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {AddressKind} from '../../@lib/address-status.js';
import type {AddressMark} from '../../@services/index.js';

import {inlineIconCSS} from './inline-icon.js';

const Marker = styled(IonIcon)<{$color: string}>`
  ${inlineIconCSS}
  color: ${({$color}) => $color};
`;

const markers: Record<
  AddressKind | AddressMark,
  {icon: string; color: string; label: string; description: string}
> = {
  signer: {
    icon: userPen,
    color: 'var(--ion-color-primary)',
    label: 'Signer',
    description: 'The account signing this message.',
  },
  own: {
    icon: user,
    color: 'var(--ion-color-primary)',
    label: 'Yours',
    description: 'Another account in your Safe.',
  },
  seen: {
    icon: history,
    color: 'var(--ion-color-medium-tint)',
    label: 'Seen before',
    description: 'Included in a message you previously signed.',
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
    color: 'var(--ion-color-safe-shade)',
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
