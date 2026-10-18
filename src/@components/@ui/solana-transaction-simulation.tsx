import {List as list} from 'lucide-react';
import {type ReactNode, useState} from 'react';
import {styled} from 'styled-components';

import {formatTokenAmount} from '../../@lib/format-decimal.js';
import {UI_LOCALE} from '../../@lib/locale.js';
import type {SolanaTransactionSimulation} from '../../@lib/simulate-solana-transaction.js';
import type {SolanaInstructionReview} from '../../@lib/solana-transaction-review.js';

import {AppIcon} from './app-icon.js';
import {Button} from './button.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from './details-popup.js';
import {IconButton} from './icon-button.js';
import {
  InfoPanel,
  InfoSectionHeader,
  InfoSectionItem,
  InfoSectionItemLabel,
  InfoSectionLoadingSpinner,
  InfoSectionRow,
  InfoSummaryRow,
  InfoTableSection,
} from './info-section.js';
import {inlineIconCSS} from './inline-icon.js';
import {
  MessageContent,
  MessageSectionTitle,
  WarningMessage,
} from './message-content.js';
import {NativeAmount} from './native-amount.js';

const Heading = styled(MessageSectionTitle).attrs({as: 'button'})`
  font-family: inherit;
  cursor: pointer;

  &:disabled {
    cursor: default;
  }
`;

const DetailsButton = styled(IconButton)`
  ${inlineIconCSS}
`;

const Status = styled.span<{
  $status: SolanaTransactionSimulation['status'];
}>`
  color: ${({$status}) =>
    $status === 'succeeded'
      ? 'var(--color-address-safe)'
      : 'var(--color-address-warning)'};
`;

const Logs = styled(MessageContent)`
  background: rgba(255, 255, 255, 0.08);
  color: inherit;
`;

const STATUS_LABELS = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  unavailable: 'Unavailable',
};

export function SolanaTransactionSimulationSection({
  result,
  instructions = [],
  onRefresh,
  disabled,
}: {
  result?: SolanaTransactionSimulation;
  instructions?: readonly SolanaInstructionReview[];
  onRefresh: () => void;
  disabled: boolean;
}): ReactNode {
  const [showDetails, setShowDetails] = useState(false);
  const pending = !result;
  const computeBudget = instructions.flatMap(({decoded}) =>
    decoded.kind === 'compute-unit-limit' ||
    decoded.kind === 'compute-unit-price'
      ? [decoded]
      : [],
  );
  const errors = result
    ? [
        result.status === 'failed'
          ? (result.error ?? 'Transaction simulation failed.')
          : result.status === 'unavailable'
            ? (result.error ?? 'Transaction simulation unavailable.')
            : undefined,
        result.fee === undefined
          ? (result.feeError ?? 'Transaction fee unavailable.')
          : undefined,
      ].filter((message): message is string => !!message)
    : [];
  const error = Array.from(new Set(errors)).join('\n');

  return (
    <>
      {(pending || result.fee !== undefined || !disabled) && (
        <InfoTableSection>
          <InfoSectionHeader>
            <Heading
              type="button"
              aria-label="View transaction simulation"
              aria-haspopup="dialog"
              disabled={pending || disabled}
              onClick={() => setShowDetails(true)}
            >
              Fee
            </Heading>
            {pending ? (
              <InfoSectionLoadingSpinner aria-label="Estimating transaction fee" />
            ) : (
              <DetailsButton
                aria-label="Transaction simulation details"
                aria-haspopup="dialog"
                disabled={disabled}
                onClick={() => setShowDetails(true)}
              >
                <AppIcon icon={list} aria-hidden="true" />
              </DetailsButton>
            )}
          </InfoSectionHeader>
          {result?.fee !== undefined && (
            <InfoPanel role="group" aria-label="Transaction fee">
              <InfoSummaryRow>
                <InfoSectionItemLabel>Expected fee</InfoSectionItemLabel>
                <span>
                  <NativeAmount
                    value={result.fee}
                    currency={{symbol: 'SOL', decimals: 9}}
                  />
                </span>
              </InfoSummaryRow>
            </InfoPanel>
          )}
        </InfoTableSection>
      )}
      {error && <WarningMessage>{error}</WarningMessage>}
      {showDetails && (
        <DetailsPopup
          aria-label="Transaction simulation"
          initialFocus="dialog"
          onDismiss={() => setShowDetails(false)}
        >
          <DetailsPopupTitle>Transaction simulation</DetailsPopupTitle>
          <DetailsPopupDivider />
          <InfoSectionRow>
            <InfoSectionItemLabel>Status</InfoSectionItemLabel>
            {result ? (
              <Status $status={result.status}>
                {STATUS_LABELS[result.status]}
              </Status>
            ) : (
              <InfoSectionLoadingSpinner aria-label="Simulating transaction" />
            )}
          </InfoSectionRow>
          {result?.fee !== undefined && (
            <InfoSectionRow>
              <InfoSectionItemLabel>Expected fee</InfoSectionItemLabel>
              <span>{formatTokenAmount(result.fee, 9)} SOL</span>
            </InfoSectionRow>
          )}
          {computeBudget.map((instruction, index) => (
            <InfoSectionRow key={index}>
              <InfoSectionItemLabel>
                {instruction.kind === 'compute-unit-limit'
                  ? 'Compute unit limit'
                  : 'Compute unit price'}
              </InfoSectionItemLabel>
              <span>
                {instruction.kind === 'compute-unit-limit'
                  ? instruction.units.toLocaleString(UI_LOCALE)
                  : `${instruction.microLamports.toLocaleString(UI_LOCALE)} µlamports / CU`}
              </span>
            </InfoSectionRow>
          ))}
          {result?.unitsConsumed !== undefined && (
            <InfoSectionRow>
              <InfoSectionItemLabel>Compute units</InfoSectionItemLabel>
              <span>{result.unitsConsumed.toLocaleString(UI_LOCALE)}</span>
            </InfoSectionRow>
          )}
          {result?.slot !== undefined && (
            <InfoSectionRow>
              <InfoSectionItemLabel>Slot</InfoSectionItemLabel>
              <span>{result.slot.toLocaleString(UI_LOCALE)}</span>
            </InfoSectionRow>
          )}
          {error && <WarningMessage>{error}</WarningMessage>}
          {!!result?.logs?.length && (
            <InfoSectionItem>
              <InfoSectionItemLabel>Logs</InfoSectionItemLabel>
              <Logs>{result.logs.join('\n')}</Logs>
            </InfoSectionItem>
          )}
          <Button
            color="neutral"
            disabled={pending || disabled}
            onClick={onRefresh}
          >
            Refresh
          </Button>
        </DetailsPopup>
      )}
    </>
  );
}
