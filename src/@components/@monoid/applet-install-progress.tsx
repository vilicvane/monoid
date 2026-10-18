import type {ReactNode} from 'react';

import {
  type AppletInstallProgress,
  describeAppletInstallProgress,
} from '../../@lib/monoid/index.js';

import {MonoidScanStatePromptContentHighlight} from './monoid-scan-prompt.js';

export function AppletInstallProgressContent({
  update,
}: {
  update: AppletInstallProgress;
}): ReactNode {
  const {status, percentage} = describeAppletInstallProgress(update);

  return (
    <>
      {status}
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
