import type {ReactNode} from 'react';

import {MonoidScanStatePromptProgress} from '../../@monoid/monoid-scan-prompt.js';

import type {CardDerivationsProgress} from './card-derivations.js';

export function CardAddressProgress({
  progress,
}: {
  progress: CardDerivationsProgress;
}): ReactNode {
  if (progress.stage === 'checking') return 'Checking card...';

  return (
    <MonoidScanStatePromptProgress
      current={progress.current}
      total={progress.total}
      showCount
    >
      {progress.stage === 'reading' ? 'Reading addresses' : 'Saving addresses'}
    </MonoidScanStatePromptProgress>
  );
}
