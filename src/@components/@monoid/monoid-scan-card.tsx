import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import monoidCardChip from '../../@assets/monoid-card-chip.svg';
import monoidLogo from '../../@assets/monoid.svg';

import {MonoidCardWaves} from './monoid-card-waves.js';

const CardFrame = styled.div`
  position: relative;
  aspect-ratio: 85.6 / 53.98;
  border-radius: calc(3.18 / 85.6 * 100%) / calc(3.18 / 53.98 * 100%);
  background-color: var(--ion-color-dark-contrast);
`;

const CardChip = styled.img`
  position: absolute;
  top: calc(96 / 270 * 100%);
  left: calc(40 / 430 * 100%);
  width: calc(56 / 430 * 100%);
`;

const CardLogo = styled.img`
  position: absolute;
  top: 50%;
  right: 0;
  width: calc(60 / 430 * 100%);
  transform: translateY(-50%) rotate(-90deg);
`;

export function MonoidScanCard({
  scanning,
  wavesActive = true,
}: {
  scanning: boolean;
  wavesActive?: boolean;
}): ReactNode {
  return (
    <CardFrame>
      <MonoidCardWaves scanning={scanning} active={wavesActive} />
      <CardChip src={monoidCardChip} alt="" />
      <CardLogo src={monoidLogo} alt="" />
    </CardFrame>
  );
}
