import {type ReactNode, useEffect, useRef, useState} from 'react';
import {styled} from 'styled-components';

import {
  APPLET_NAMES,
  type AppletStage,
  type IdentityInstallationOptions,
  type MonoidAppletInstallation,
  getAppletCatalog,
  validateCardAlias,
} from '../../../@lib/monoid/index.js';
import {
  getDefaultOTPAuthorityUrl,
  resolveOTPAuthorityInstallationOptions,
} from '../../../@lib/otp-authority.js';
import {Button} from '../../@ui/button.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupSection,
  DetailsPopupTitle,
} from '../../@ui/details-popup.js';
import {InfoSectionItem, InfoSectionItemLabel} from '../../@ui/info-section.js';
import {PopupInput} from '../../@ui/input.js';
import {InfoMessage} from '../../@ui/message-content.js';
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
  onInstall: (
    identityOptions: IdentityInstallationOptions,
    alias?: string,
  ) => void;
  onDismiss: () => void;
}): ReactNode {
  const [authorityUrl, setAuthorityUrl] = useState(getDefaultOTPAuthorityUrl);
  const [authorityEnabled, setAuthorityEnabled] = useState(!!authorityUrl);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();
  const [aliasEnabled, setAliasEnabled] = useState(false);
  const [alias, setAlias] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  const installsIdentity = fresh || installation?.identity.installed !== true;
  const setsAlias = installsIdentity && !fresh && aliasEnabled;
  useEffect(() => () => controller.current?.abort(), []);
  const aliasInput = useRef<HTMLInputElement>(null);
  // Focusing without scrolling keeps the popup still while the keyboard opens.
  useEffect(() => {
    if (setsAlias) aliasInput.current?.focus({preventScroll: true});
  }, [setsAlias]);

  function dismiss(): void {
    controller.current?.abort();
    onDismiss();
  }

  async function install(): Promise<void> {
    if (controller.current) return;
    const task = new AbortController();
    controller.current = task;
    setError(undefined);
    setConnecting(true);
    try {
      if (setsAlias) validateCardAlias(alias);
      const options =
        installsIdentity && authorityEnabled
          ? await resolveOTPAuthorityInstallationOptions(
              authorityUrl,
              task.signal,
            )
          : {};
      task.signal.throwIfAborted();
      onInstall(options, setsAlias ? alias : undefined);
    } catch (error) {
      if (!task.signal.aborted)
        setError(
          error instanceof Error
            ? error.message
            : 'Could not connect to the authority',
        );
    } finally {
      if (!task.signal.aborted) setConnecting(false);
      if (controller.current === task) controller.current = undefined;
    }
  }
  const optional = getAppletCatalog().filter(applet => applet.optional);
  const missingSelection = selected.some(
    stage => !installation?.optional?.[stage]?.installed,
  );
  return (
    <DetailsPopup aria-label="Install applets" onDismiss={dismiss}>
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
              disabled={installed || connecting}
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
      {installsIdentity && (
        <DetailsPopupSection>
          {!fresh && (
            <AppletToggle
              checked={aliasEnabled}
              disabled={connecting}
              onChange={setAliasEnabled}
            >
              Alias
            </AppletToggle>
          )}
          {setsAlias && (
            <InfoSectionItem as="label">
              <InfoSectionItemLabel>Card alias</InfoSectionItemLabel>
              <PopupInput
                aria-label="Card alias"
                placeholder="Enter card alias"
                ref={aliasInput}
                value={alias}
                disabled={connecting}
                onChange={event => setAlias(event.target.value)}
              />
            </InfoSectionItem>
          )}
          <AppletToggle
            checked={authorityEnabled}
            disabled={connecting}
            onChange={setAuthorityEnabled}
          >
            Authority
          </AppletToggle>
          {authorityEnabled && (
            <InfoSectionItem as="label">
              <InfoSectionItemLabel>Authority URL</InfoSectionItemLabel>
              <PopupInput
                aria-label="Authority URL"
                type="url"
                value={authorityUrl}
                disabled={connecting}
                onChange={event => setAuthorityUrl(event.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
              />
            </InfoSectionItem>
          )}
        </DetailsPopupSection>
      )}
      {error && <InfoMessage>{error}</InfoMessage>}
      <Button
        disabled={
          connecting ||
          (installsIdentity && authorityEnabled && !authorityUrl.trim()) ||
          (setsAlias && !alias.trim()) ||
          (!fresh &&
            installation?.monoid.installed === true &&
            !missingSelection)
        }
        onClick={() => void install()}
      >
        {connecting ? 'Connecting...' : fresh ? 'Continue' : 'Install'}
      </Button>
    </DetailsPopup>
  );
}
