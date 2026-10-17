import {IonIcon} from '@ionic/react';
import badgeCheck from 'lucide-static/icons/badge-check.svg';
import circleHelp from 'lucide-static/icons/circle-help.svg';
import history from 'lucide-static/icons/history.svg';
import {type ReactNode, useState} from 'react';
import {styled} from 'styled-components';

import type {
  EvmCalldataCandidate,
  EvmContractVerification,
} from '../../@lib/evm-calldata.js';

import {CenteredPopup} from './centered-popup.js';
import {
  InfoSectionItemLabel,
  InfoSectionRow,
  InfoSectionTitle,
} from './info-section.js';
import {inlineIconCSS, inlineIconRowCSS} from './inline-icon.js';
import {PopupAddress} from './popup-address.js';

const Trigger = styled.button`
  ${inlineIconRowCSS}
  align-items: flex-start;
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 14px;
  line-height: 21px;
  text-align: left;
`;

const Signature = styled.span<{$verified: boolean; $seen: boolean}>`
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  color: ${({$verified, $seen}) =>
    $verified
      ? 'var(--ion-color-primary)'
      : $seen
        ? 'inherit'
        : 'var(--color-text-warning)'};
`;

const Icon = styled(IonIcon)<{$verified: boolean; $seen: boolean}>`
  ${inlineIconCSS}
  /* Center on the first text line when the signature wraps. */
  margin-top: calc((1lh - 1em) / 2);
  color: ${({$verified, $seen}) =>
    $verified
      ? 'var(--ion-color-safe)'
      : $seen
        ? 'var(--ion-color-medium-tint)'
        : 'var(--color-text-warning)'};
`;

const Status = styled.span<{$verified: boolean}>`
  color: ${({$verified}) =>
    $verified ? 'var(--ion-color-safe)' : 'var(--ion-color-warning)'};
`;

export function EvmCalldataVerification({
  candidate,
  target,
  seen,
}: {
  candidate: EvmCalldataCandidate;
  target?: string;
  seen: boolean | undefined;
}): ReactNode {
  const [showDetails, setShowDetails] = useState(false);
  const verification =
    candidate.source === 'abi' ? candidate.verification : undefined;
  const verified = !!verification?.runtimeMatch;
  const source =
    candidate.source === 'signature'
      ? 'Signature lookup'
      : candidate.abiAddress?.toLowerCase() === target?.toLowerCase()
        ? 'Contract ABI'
        : 'Implementation ABI';
  const label = verified ? 'Verified' : 'Unverified';

  return (
    <>
      <Trigger
        type="button"
        aria-haspopup="dialog"
        aria-label={`${candidate.signature}: ${!verified && seen ? 'Seen before' : label}: ${source}`}
        onClick={() => setShowDetails(true)}
      >
        <Signature $verified={verified} $seen={!!seen}>
          {candidate.signature}
        </Signature>
        <Icon
          icon={verified ? badgeCheck : seen ? history : circleHelp}
          $verified={verified}
          $seen={!!seen}
          aria-hidden="true"
        />
      </Trigger>
      {showDetails && (
        <CenteredPopup
          aria-label="Source verification"
          onDismiss={() => setShowDetails(false)}
        >
          <InfoSectionTitle>Source verification</InfoSectionTitle>
          <InfoSectionRow>
            <InfoSectionItemLabel>Status</InfoSectionItemLabel>
            <Status $verified={verified}>{label}</Status>
          </InfoSectionRow>
          <InfoSectionRow>
            <InfoSectionItemLabel>
              Seen in signed transactions
            </InfoSectionItemLabel>
            <span>{seen === undefined ? 'Unknown' : seen ? 'Yes' : 'No'}</span>
          </InfoSectionRow>
          <InfoSectionRow>
            <InfoSectionItemLabel>Source</InfoSectionItemLabel>
            <span>Sourcify</span>
          </InfoSectionRow>
          <InfoSectionRow>
            <InfoSectionItemLabel>Decoded with</InfoSectionItemLabel>
            <span>{source}</span>
          </InfoSectionRow>
          {candidate.abiAddress && (
            <PopupAddress>{candidate.abiAddress}</PopupAddress>
          )}
          {candidate.source === 'abi' && (
            <>
              <InfoSectionRow>
                <InfoSectionItemLabel>Runtime code</InfoSectionItemLabel>
                <span>{matchLabel(verification?.runtimeMatch)}</span>
              </InfoSectionRow>
              <InfoSectionRow>
                <InfoSectionItemLabel>Creation code</InfoSectionItemLabel>
                <span>{matchLabel(verification?.creationMatch)}</span>
              </InfoSectionRow>
              {verification?.verifiedAt && (
                <InfoSectionRow>
                  <InfoSectionItemLabel>Verified at</InfoSectionItemLabel>
                  <span>
                    {new Date(verification.verifiedAt).toLocaleString()}
                  </span>
                </InfoSectionRow>
              )}
            </>
          )}
        </CenteredPopup>
      )}
    </>
  );
}

function matchLabel(
  match: EvmContractVerification['runtimeMatch'] | undefined,
): string {
  return match === 'exact_match'
    ? 'Exact match'
    : match === 'match'
      ? 'Match'
      : 'Not verified';
}
