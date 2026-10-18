import {Check as check, X as x} from 'lucide-react';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {CardInformation} from '../../../../@lib/global-platform/card-information.js';
import {
  type CardInstallationCheck,
  getCardExpectedCryptography,
  getCardInstallationChecks,
} from '../../../../@lib/global-platform/installation-support.js';
import {AppIcon} from '../../../@ui/app-icon.js';
import {
  InfoFieldset,
  InfoLegend,
  InfoSectionItemLabel,
  InfoSectionRow,
} from '../../../@ui/info-section.js';
import {InfoMessage} from '../../../@ui/message-content.js';

type CapabilityCheck = CardInstallationCheck & {expected?: boolean};

const CardInformationFieldset = styled(InfoFieldset)`
  padding-top: var(--info-fieldset-padding);
`;

const CheckLabel = styled.span`
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 6px;
  min-width: 0;
`;

const Checks = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;

  display: flex;
  flex-direction: column;
  gap: 12px;
`;

const CheckItem = styled.li`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 24px;
`;

const CheckIcon = styled(AppIcon)<{$supported: boolean}>`
  flex-shrink: 0;
  font-size: 20px;
  --icon-stroke-width: 2.5;
  color: ${props =>
    props.$supported ? 'var(--ion-color-safe)' : 'var(--ion-color-danger)'};
`;

function CapabilityChecks({items}: {items: CapabilityCheck[]}): ReactNode {
  return (
    <Checks>
      {items.map(item => {
        const [name, bits] = item.label.split(' · ');

        return (
          <CheckItem key={item.label}>
            <CheckLabel>
              <span>{name}</span>
              {bits && (
                <InfoSectionItemLabel as="span">{bits}</InfoSectionItemLabel>
              )}
            </CheckLabel>
            <CheckIcon
              icon={item.supported ? check : x}
              $supported={item.supported}
              role="img"
              aria-label={
                item.supported
                  ? item.expected
                    ? 'Expected support'
                    : 'Supported'
                  : 'Not supported'
              }
            />
          </CheckItem>
        );
      })}
    </Checks>
  );
}

export function CardSetupInformation({
  information,
}: {
  information: CardInformation;
}): ReactNode {
  const checks: CapabilityCheck[] = getCardInstallationChecks(information).map(
    item => ({
      ...item,
      label: item.label === 'AES-128' ? 'AES · 128-bit' : item.label,
    }),
  );

  for (const {label} of getCardExpectedCryptography(information)) {
    if (!checks.some(item => item.label === label)) {
      checks.push({label, supported: true, expected: true});
    }
  }

  return (
    <>
      <CardInformationFieldset>
        <InfoLegend>Card versions</InfoLegend>
        {information.globalPlatformVersion && (
          <InfoSectionRow>
            <InfoSectionItemLabel as="span">
              GlobalPlatform
            </InfoSectionItemLabel>
            <span>{information.globalPlatformVersion}</span>
          </InfoSectionRow>
        )}
        {information.javaCardVersion && (
          <InfoSectionRow>
            <InfoSectionItemLabel as="span">Java Card</InfoSectionItemLabel>
            <span>{information.javaCardVersion}</span>
          </InfoSectionRow>
        )}
      </CardInformationFieldset>
      <InfoMessage>Requires Java Card 3.0.5 or later</InfoMessage>
      {checks.length > 0 && (
        <CardInformationFieldset>
          <InfoLegend>Checklist</InfoLegend>
          <CapabilityChecks items={checks} />
        </CardInformationFieldset>
      )}
    </>
  );
}
