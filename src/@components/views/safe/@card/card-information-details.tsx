import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {CardInformation} from '../../../../@lib/global-platform/card-information.js';
import {getCardExpectedCryptography} from '../../../../@lib/global-platform/installation-support.js';
import {
  InfoSection,
  InfoSectionDivider,
  InfoSectionFlowItem,
  InfoSectionItemContent,
  InfoSectionItemLabel,
  InfoSectionTitle,
} from '../../../@ui/info-section.js';

type InformationField = readonly [label: string, value: ReactNode];

const SectionTitle = styled(InfoSectionTitle)`
  text-align: center;
`;

function InformationSection({
  title,
  fields,
}: {
  title: string;
  fields: readonly InformationField[];
}): ReactNode {
  const available = fields.filter(([, value]) => value !== undefined);

  if (!available.length) return null;

  return (
    <InfoSection data-popup-animation-group>
      <SectionTitle>{title}</SectionTitle>
      <InfoSectionDivider />
      {available.map(([label, value], index) => (
        <InfoSectionFlowItem key={index}>
          <InfoSectionItemLabel>{label}</InfoSectionItemLabel>
          <InfoSectionItemContent>{value}</InfoSectionItemContent>
        </InfoSectionFlowItem>
      ))}
    </InfoSection>
  );
}

function formatValues(
  values: readonly string[] | undefined,
): string | undefined {
  return values === undefined ? undefined : values.join(', ') || 'None';
}

export function CardInformationDetails({
  information,
}: {
  information: CardInformation;
}): ReactNode {
  const {cplc, capabilities, keyInformation} = information;
  const cryptography = getCardExpectedCryptography(information);
  const secureChannels: InformationField[] = [];

  if (information.secureChannels.length) {
    secureChannels.push([
      'Card recognition',
      information.secureChannels.join(', '),
    ]);
  }

  for (const channel of capabilities?.secureChannels ?? []) {
    secureChannels.push([
      `${channel.protocol} options`,
      channel.options.map(option => `i=${option}`).join(', '),
    ]);

    if (channel.keys.length) {
      secureChannels.push([
        `${channel.protocol} keys`,
        channel.keys.join(', '),
      ]);
    }
  }

  return (
    <>
      <InformationSection
        title="Expected support"
        fields={cryptography.map(({label, evidence}) => [
          label,
          evidence.join(', '),
        ])}
      />
      <InformationSection
        title="Card"
        fields={[
          ['Serial number', cplc?.icSerialNumber],
          ['Card manager AID', information.cardManagerAid],
          ['GlobalPlatform', information.globalPlatformVersion],
          ['Java Card major version', information.javaCardVersion],
          ['IC fabricator', cplc?.icFabricator],
          ['IC type', cplc?.icType],
          ['Operating system ID', cplc?.operatingSystemId],
          ['OS release date', cplc?.operatingSystemReleaseDate],
          ['OS release level', cplc?.operatingSystemReleaseLevel],
        ]}
      />
      <InformationSection title="Secure channels" fields={secureChannels} />
      <InformationSection
        title="GP management algorithms"
        fields={[
          ['Load file hash', formatValues(capabilities?.loadFileHashes)],
          ['Load file encryption', formatValues(capabilities?.loadFileCiphers)],
          [
            'Token verification',
            formatValues(capabilities?.tokenVerificationCiphers),
          ],
          [
            'Receipt generation',
            formatValues(capabilities?.receiptGenerationCiphers),
          ],
          [
            'DAP verification',
            formatValues(capabilities?.dapVerificationCiphers),
          ],
          ['ECC key parameters', formatValues(capabilities?.eccKeyParameters)],
        ]}
      />
      <InformationSection
        title="Privileges"
        fields={[
          ['Security domain', formatValues(capabilities?.domainPrivileges)],
          ['Application', formatValues(capabilities?.applicationPrivileges)],
        ]}
      />
      {keyInformation !== undefined && (
        <InformationSection
          title="Management keys"
          fields={
            keyInformation.length
              ? keyInformation.map(key => [
                  `Version ${key.version} · ID ${key.id}`,
                  key.components
                    .map(
                      component =>
                        component.type +
                        (component.length !== undefined
                          ? ` · ${component.lengthIsMinimum ? '≥' : ''}${component.length} bytes`
                          : '') +
                        (component.parameterReference !== undefined
                          ? ` · parameter reference ${component.parameterReference}`
                          : ''),
                    )
                    .join(', '),
                ])
              : [['Keys', 'None']]
          }
        />
      )}
    </>
  );
}
