import {List as list} from 'lucide-react';
import {type ReactNode, useEffect, useState} from 'react';
import {styled} from 'styled-components';

import type {BitcoinFeeRates} from '../../../@lib/bitcoin-api.js';
import type {BitcoinTransactionPreview} from '../../../@lib/bitcoin-transaction.js';
import {AppIcon} from '../../@ui/app-icon.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupSection,
  DetailsPopupTitle,
} from '../../@ui/details-popup.js';
import {FormattedNumber} from '../../@ui/formatted-number.js';
import {IconButton} from '../../@ui/icon-button.js';
import {
  InfoPanel,
  InfoSectionHeader,
  InfoSectionItemLabel,
  InfoSectionRow,
  InfoSummaryRow,
  InfoTableSection,
} from '../../@ui/info-section.js';
import {inlineIconCSS} from '../../@ui/inline-icon.js';
import {
  InfoMessage,
  MessageSectionTags,
  MessageSectionTitle,
} from '../../@ui/message-content.js';
import {NativeAmount} from '../../@ui/native-amount.js';
import {Tag} from '../../@ui/tag.js';

import {type BitcoinFeeChoice, BitcoinFeeEditor} from './bitcoin-fee-editor.js';

const BTC = {symbol: 'BTC', decimals: 8};

const Heading = styled(MessageSectionTags).attrs({as: 'button'})`
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
`;

const DetailsButton = styled(IconButton)`
  ${inlineIconCSS}
`;

const DetailValue = styled.span`
  max-width: 100%;
  overflow-wrap: anywhere;
`;

export function BitcoinFeeDetails({
  fees,
  feeError,
  choice,
  customFee,
  preview,
  disabled,
  onApply,
}: {
  fees?: BitcoinFeeRates;
  feeError?: string;
  choice: BitcoinFeeChoice;
  customFee: string;
  preview?: BitcoinTransactionPreview;
  disabled?: boolean;
  onApply?: (choice: BitcoinFeeChoice, customFee: string) => void;
}): ReactNode {
  const [showDetails, setShowDetails] = useState(false);
  const rate =
    preview?.feeRate ??
    (choice === 'custom' ? Number(customFee) : fees?.[choice]);
  const validRate = rate !== undefined && Number.isFinite(rate) && rate >= 1;

  useEffect(() => {
    if (disabled) setShowDetails(false);
  }, [disabled]);

  return (
    <InfoTableSection>
      <InfoSectionHeader>
        <Heading
          type="button"
          aria-label={onApply ? 'Edit network fee' : 'View network fee details'}
          aria-haspopup="dialog"
          disabled={disabled}
          onClick={() => setShowDetails(true)}
        >
          <MessageSectionTitle as="span">Network fee</MessageSectionTitle>
          <Tag as="span" aria-label="Standard network rate">
            {fees ? (
              <FormattedNumber
                interactive={false}
                value={fees.normal.toString()}
                unit="sat/vB"
              />
            ) : feeError ? (
              'Unavailable'
            ) : (
              'Loading…'
            )}
          </Tag>
        </Heading>
        <DetailsButton
          aria-label="Network fee details"
          aria-haspopup="dialog"
          disabled={disabled}
          onClick={() => setShowDetails(true)}
        >
          <AppIcon icon={list} aria-hidden="true" />
        </DetailsButton>
      </InfoSectionHeader>
      <InfoPanel
        role="group"
        aria-label={preview ? 'Payment summary' : 'Network fee settings'}
      >
        <InfoSummaryRow>
          <InfoSectionItemLabel>Fee rate</InfoSectionItemLabel>
          <span aria-label="Selected fee rate">
            {validRate ? (
              <FormattedNumber value={rate.toString()} unit="sat/vB" />
            ) : feeError || choice === 'custom' ? (
              'Unavailable'
            ) : (
              'Loading…'
            )}
          </span>
        </InfoSummaryRow>
        {preview && (
          <>
            <InfoSummaryRow>
              <InfoSectionItemLabel>Fee</InfoSectionItemLabel>
              <NativeAmount value={preview.feeSats} currency={BTC} />
            </InfoSummaryRow>
            <InfoSummaryRow>
              <InfoSectionItemLabel>Total</InfoSectionItemLabel>
              <NativeAmount value={preview.totalSats} currency={BTC} />
            </InfoSummaryRow>
          </>
        )}
      </InfoPanel>
      {showDetails && !disabled && (
        <DetailsPopup
          aria-label="Network fee details"
          initialFocus="dialog"
          onDismiss={() => setShowDetails(false)}
        >
          <DetailsPopupTitle>Network fee details</DetailsPopupTitle>
          <DetailsPopupDivider />
          <DetailsPopupSection>
            <InfoSectionRow>
              <InfoSectionItemLabel>Standard network rate</InfoSectionItemLabel>
              <DetailValue>
                {fees
                  ? `${fees.normal} sat/vB`
                  : feeError
                    ? 'Unavailable'
                    : 'Loading…'}
              </DetailValue>
            </InfoSectionRow>
          </DetailsPopupSection>
          {onApply ? (
            <BitcoinFeeEditor
              fees={fees}
              feeError={feeError}
              choice={choice}
              customFee={customFee}
              onApply={(nextChoice, nextFee) => {
                onApply(nextChoice, nextFee);
                setShowDetails(false);
              }}
            />
          ) : (
            <DetailsPopupSection>
              <InfoSectionRow>
                <InfoSectionItemLabel>Fee rate</InfoSectionItemLabel>
                <DetailValue>
                  {validRate ? `${rate} sat/vB` : 'Unavailable'}
                </DetailValue>
              </InfoSectionRow>
              {preview && (
                <InfoSectionRow>
                  <InfoSectionItemLabel>Estimated size</InfoSectionItemLabel>
                  <DetailValue>{preview.estimatedVsize} vB</DetailValue>
                </InfoSectionRow>
              )}
              {feeError && <InfoMessage>{feeError}</InfoMessage>}
            </DetailsPopupSection>
          )}
        </DetailsPopup>
      )}
    </InfoTableSection>
  );
}
