import type {ReactNode} from 'react';

import {ScanWaves} from '../@ui/scan-waves.js';

const WAVE_ORIGIN = {x: 56 / 430, y: 56 / 270};

export function MonoidCardWaves({
  scanning,
  active,
}: {
  scanning: boolean;
  active: boolean;
}): ReactNode {
  return <ScanWaves scanning={scanning} active={active} origin={WAVE_ORIGIN} />;
}
