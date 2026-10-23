import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {
  APPLET_NAMES,
  type AppletStage,
  type MonoidAppletInstallation,
  getAppletCatalog,
} from '../../../@lib/monoid/index.js';
import {Button} from '../../@ui/button.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupSection,
  DetailsPopupTitle,
} from '../../@ui/details-popup.js';
import {Toggle} from '../../@ui/toggle.js';

const AppletToggle = styled(Toggle)`
  color: inherit;
`;

export function AppletSelectionPopup({
  installation,
  selected,
  fresh = false,
  onChange,
  onInstall,
  onDismiss,
}: {
  installation?: MonoidAppletInstallation;
  selected: readonly AppletStage[];
  fresh?: boolean;
  onChange: (stages: AppletStage[]) => void;
  onInstall: () => void;
  onDismiss: () => void;
}): ReactNode {
  const optional = getAppletCatalog().filter(applet => applet.optional);
  const missingSelection = selected.some(
    stage => !installation?.optional?.[stage]?.installed,
  );
  return (
    <DetailsPopup aria-label="Install applets" onDismiss={onDismiss}>
      <DetailsPopupTitle>
        {fresh ? 'Fresh install' : 'Install applets'}
      </DetailsPopupTitle>
      <DetailsPopupDivider />
      <DetailsPopupSection>
        <AppletToggle checked disabled onChange={() => {}}>
          Monoid Applet
        </AppletToggle>
        {optional.map(applet => {
          const installed =
            !fresh &&
            installation?.optional?.[applet.stage]?.installed === true;
          return (
            <AppletToggle
              key={applet.stage}
              checked={installed || selected.includes(applet.stage)}
              disabled={installed}
              onChange={checked =>
                onChange(
                  checked
                    ? [...selected, applet.stage]
                    : selected.filter(stage => stage !== applet.stage),
                )
              }
            >
              {APPLET_NAMES[applet.stage]}
            </AppletToggle>
          );
        })}
      </DetailsPopupSection>
      <Button
        disabled={
          !fresh && installation?.monoid.installed === true && !missingSelection
        }
        onClick={onInstall}
      >
        {fresh ? 'Continue' : 'Install'}
      </Button>
    </DetailsPopup>
  );
}
