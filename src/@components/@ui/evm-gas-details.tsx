import {IonIcon} from '@ionic/react';
import {formatUnits} from 'ethers';
import list from 'lucide-static/icons/list.svg';
import {type ReactNode, useEffect, useState} from 'react';
import {css, styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import type {NativeCurrency} from '../../@lib/chain-names.js';
import type {EvmGasSettings} from '../../@lib/evm-gas-settings.js';
import {
  type EvmGasComparison,
  type EvmGasEstimate,
  type EvmGasTransaction,
  compareEvmGas,
} from '../../@lib/evm-gas.js';
import {UI_LOCALE} from '../../@lib/locale.js';
import {
  GAS_HISTORY_MAX_AGE_SECONDS,
  type GasHistory,
} from '../../@services/index.js';

import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupSection,
  DetailsPopupTitle,
} from './details-popup.js';
import {EvmGasEditor} from './evm-gas-editor.js';
import {FormattedNumber} from './formatted-number.js';
import {IconButton} from './icon-button.js';
import {
  InfoPanel,
  InfoSectionHeader,
  InfoSectionItemLabel,
  InfoSectionRow,
  InfoSummaryRow,
  InfoTableSection,
} from './info-section.js';
import {inlineIconCSS} from './inline-icon.js';
import {MessageSectionTags, MessageSectionTitle} from './message-content.js';
import {NativeAmount} from './native-amount.js';
import {Tag} from './tag.js';

const Heading = styled(MessageSectionTags).attrs({as: 'button'})`
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
`;

const GAS_LEVEL_LABELS = {low: 'Low', normal: 'Normal', high: 'High'};

function gasLevelColor(level?: EvmGasComparison['level']): string | undefined {
  return level === 'low'
    ? 'var(--ion-color-safe-shade)'
    : level === 'high'
      ? 'var(--color-text-caution)'
      : level === 'normal'
        ? 'var(--ion-color-primary-shade)'
        : undefined;
}

const RateTag = styled(Tag)<{$level?: EvmGasComparison['level']}>`
  ${({$level}) => {
    const color = gasLevelColor($level);
    return (
      color &&
      css`
        color: ${color};
        border-color: color-mix(in srgb, ${color} 45%, white);
        background-color: color-mix(in srgb, ${color} 12%, white);
      `
    );
  }}
`;

const DetailsButton = styled(IconButton)`
  ${inlineIconCSS}
`;

const DetailValue = styled.span`
  max-width: 100%;
  overflow-wrap: anywhere;
`;

const Level = styled(DetailValue)<{$level?: EvmGasComparison['level']}>`
  color: ${({$level}) => gasLevelColor($level) ?? 'inherit'};
`;

const Note = styled.div`
  color: var(--color-text-label);
  font-size: 12px;
  text-align: center;
`;

export const EvmGasDetails = ({
  chainId,
  transaction,
  estimate,
  currency,
  showFees = true,
  onChange,
  minimum,
}: {
  chainId: string;
  transaction: EvmGasTransaction;
  estimate: EvmGasEstimate;
  currency?: NativeCurrency;
  showFees?: boolean;
  onChange?: (settings: EvmGasSettings) => void;
  minimum?: EvmGasSettings;
}): ReactNode => {
  const {gasHistoryService} = useEntrances();
  const [showDetails, setShowDetails] = useState(false);
  const [history, setHistory] = useState<{
    chainId: string;
    value: GasHistory | undefined;
  }>();
  const gas = estimate;
  const eip1559 = transaction.type === 2;
  const supportsHistory = eip1559 && gasHistoryService.supports(chainId);
  const currentHistory = history?.chainId === chainId ? history : undefined;
  const window = currentHistory?.value?.windows['24h'];
  const comparison =
    supportsHistory &&
    window?.status === 'ready' &&
    gas?.networkFeePerGas !== undefined
      ? compareEvmGas(gas.networkFeePerGas, window)
      : undefined;
  const feePerGas = eip1559 ? transaction.maxFeePerGas! : transaction.gasPrice!;
  const maximumFee = transaction.gasLimit * feePerGas;
  const expectedFee = eip1559 ? gas?.expectedFee : maximumFee;

  useEffect(() => {
    if (!supportsHistory) return;
    let cancelled = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;

    void gasHistoryService.getHistory(chainId).then(value => {
      if (cancelled) return;
      setHistory({chainId, value});

      if (value) {
        const updatedAt = Math.min(
          value.updatedAt ?? Infinity,
          value.windows['24h'].to,
          value.windows['7d'].to,
        );

        expiry = setTimeout(
          () => setHistory({chainId, value: undefined}),
          (updatedAt + GAS_HISTORY_MAX_AGE_SECONDS) * 1000 - Date.now(),
        );
      }
    });

    return () => {
      cancelled = true;
      clearTimeout(expiry);
    };
  }, [gasHistoryService, chainId, supportsHistory]);

  return (
    <InfoTableSection>
      <InfoSectionHeader>
        <Heading
          type="button"
          aria-label={onChange ? 'Edit gas' : 'View gas details'}
          aria-haspopup="dialog"
          onClick={() => setShowDetails(true)}
        >
          <MessageSectionTitle as="span">Gas</MessageSectionTitle>
          <RateTag
            as="span"
            $level={comparison?.level}
            aria-label={eip1559 ? 'Current base fee' : 'Current gas price'}
            title={
              comparison
                ? `${GAS_LEVEL_LABELS[comparison.level]} compared with the past 24 hours`
                : undefined
            }
          >
            {gas?.networkFeePerGas !== undefined ? (
              <FormattedNumber
                interactive={false}
                value={formatUnits(gas.networkFeePerGas, 'gwei')}
                unit="gwei"
              />
            ) : (
              'Unavailable'
            )}
          </RateTag>
        </Heading>
        <DetailsButton
          aria-label="Gas details"
          aria-haspopup="dialog"
          onClick={() => setShowDetails(true)}
        >
          <IonIcon icon={list} aria-hidden="true" />
        </DetailsButton>
      </InfoSectionHeader>
      {showFees && (
        <InfoPanel role="group" aria-label="Gas fees">
          <InfoSummaryRow>
            <InfoSectionItemLabel>Expected fee</InfoSectionItemLabel>
            <span>
              {expectedFee !== undefined ? (
                <NativeAmount value={expectedFee} currency={currency} />
              ) : (
                'Unavailable'
              )}
            </span>
          </InfoSummaryRow>
          <InfoSummaryRow>
            <InfoSectionItemLabel>Max. fee</InfoSectionItemLabel>
            <span>
              <NativeAmount value={maximumFee} currency={currency} />
            </span>
          </InfoSummaryRow>
        </InfoPanel>
      )}
      {showDetails && (
        <DetailsPopup
          aria-label="Gas details"
          initialFocus="dialog"
          onDismiss={() => setShowDetails(false)}
        >
          <DetailsPopupTitle>Gas details</DetailsPopupTitle>
          <DetailsPopupDivider />
          <DetailsPopupSection>
            <InfoSectionRow>
              <InfoSectionItemLabel>
                {eip1559 ? 'Current base fee' : 'Current gas price'}
              </InfoSectionItemLabel>
              <DetailValue>
                {gas?.networkFeePerGas !== undefined
                  ? `${formatUnits(gas.networkFeePerGas, 'gwei')} gwei`
                  : 'Unavailable'}
              </DetailValue>
            </InfoSectionRow>
            {supportsHistory && (
              <>
                <InfoSectionRow>
                  <InfoSectionItemLabel>Base fee level</InfoSectionItemLabel>
                  <Level $level={comparison?.level}>
                    {comparison
                      ? GAS_LEVEL_LABELS[comparison.level]
                      : window?.status === 'collecting'
                        ? 'Collecting history'
                        : !currentHistory
                          ? 'Loading…'
                          : 'Unavailable'}
                  </Level>
                </InfoSectionRow>
                <InfoSectionRow>
                  <InfoSectionItemLabel>Compared with</InfoSectionItemLabel>
                  <DetailValue>Past 24 hours</DetailValue>
                </InfoSectionRow>
              </>
            )}
          </DetailsPopupSection>
          {onChange ? (
            <EvmGasEditor
              minimum={minimum}
              chainId={chainId}
              transaction={transaction}
              networkFeePerGas={gas?.networkFeePerGas}
              currency={currency}
              onApply={settings => {
                onChange(settings);
                setShowDetails(false);
              }}
            />
          ) : (
            <DetailsPopupSection>
              <InfoSectionRow>
                <InfoSectionItemLabel>Gas limit</InfoSectionItemLabel>
                <DetailValue>
                  {transaction.gasLimit.toLocaleString(UI_LOCALE)}
                </DetailValue>
              </InfoSectionRow>
              <InfoSectionRow>
                <InfoSectionItemLabel>
                  {eip1559 ? 'Max. fee per gas' : 'Gas price'}
                </InfoSectionItemLabel>
                <DetailValue>{formatUnits(feePerGas, 'gwei')} gwei</DetailValue>
              </InfoSectionRow>
              {eip1559 && (
                <InfoSectionRow>
                  <InfoSectionItemLabel>Max. priority fee</InfoSectionItemLabel>
                  <DetailValue>
                    {formatUnits(transaction.maxPriorityFeePerGas!, 'gwei')}{' '}
                    gwei
                  </DetailValue>
                </InfoSectionRow>
              )}
            </DetailsPopupSection>
          )}
          <Note>Additional network fees are not included.</Note>
        </DetailsPopup>
      )}
    </InfoTableSection>
  );
};
