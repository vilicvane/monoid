import type {ReactNode} from 'react';

import {
  type AppletInstallProgress,
  type AppletReplacementProgress,
  describeAppletInstallProgress,
} from '../../@lib/monoid/index.js';

import {MonoidScanStatePromptContentHighlight} from './monoid-scan-prompt.js';

export function AppletInstallProgressContent({
  update,
}: {
  update: AppletInstallProgress | AppletReplacementProgress;
}): ReactNode {
  const {status, percentage, count} = describeAppletInstallProgress(update);

  return (
    <>
      {status}
      {count && (
        <>
          <br />
          <MonoidScanStatePromptContentHighlight>
            {count.completed}
          </MonoidScanStatePromptContentHighlight>
          /{count.total}
        </>
      )}
      {percentage !== undefined && (
        <>
          <br />
          <MonoidScanStatePromptContentHighlight>
            {percentage}%
          </MonoidScanStatePromptContentHighlight>
        </>
      )}
    </>
  );
}
