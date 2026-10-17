import {IonIcon} from '@ionic/react';
import {formatUnits} from 'ethers';
import info from 'lucide-static/icons/info.svg';
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
  estimateEvmGas,
} from '../../@lib/evm-gas.js';
import {
  GAS_HISTORY_MAX_AGE_SECONDS,
  type GasHistory,
} from '../../@services/index.js';

import {CenteredPopup} from './centered-popup.js';
import {EvmGasEditor} from './evm-gas-editor.js';
import {FormattedNumber} from './formatted-number.js';
import {IconButton} from './icon-button.js';
import {
  InfoSection,
  InfoSectionHeader,
  InfoSectionItemLabel,
  InfoSectionRow,
  InfoSectionTitle,
  InfoTable,
  InfoTableSummary,
} from './info-section.js';
import {LoadingSpinner} from './loading-spinner.js';
import {MessageSectionTitle} from './message-content.js';
import {NativeAmount} from './native-amount.js';
import {Tag} from './tag.js';

const Section = styled(InfoSection)`
  gap: 9px;
`;

const Heading = styled.div`
  display: flex;
  align-items: center;
  min-width: 0;
  isolation: isolate;
`;

const Title = styled(MessageSectionTitle)`
  z-index: 1;
  margin-right: calc(-1 * var(--tag-overlap) - var(--tag-inline-margin));
  background-color: white;
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
  color: var(--ion-color-medium-tint);
  font-size: 16px;
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
  currency,
  showFees = true,
  onChange,
}: {
  chainId: string;
  transaction: EvmGasTransaction;
  currency?: NativeCurrency;
  showFees?: boolean;
  onChange?: (settings: EvmGasSettings) => void;
}): ReactNode => {
  const {chainService, gasHistoryService} = useEntrances();
  const [showDetails, setShowDetails] = useState(false);
  const [estimate, setEstimate] = useState<{
    chainId: string;
    transaction: EvmGasTransaction;
    value: EvmGasEstimate;
  }>();
  const [history, setHistory] = useState<{
    chainId: string;
    value: GasHistory | undefined;
  }>();
  const current =
    estimate?.chainId === chainId && estimate.transaction === transaction
      ? estimate
      : undefined;
  const gas = current?.value;
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
    let cancelled = false;

    void chainService
      .getRPC(chainId)
      .then(async provider => {
        const value = await estimateEvmGas(transaction, provider);
        if (cancelled) return;
        setEstimate({chainId, transaction, value});
      })
      .catch(() => {
        if (!cancelled) setEstimate({chainId, transaction, value: {}});
      });

    return () => {
      cancelled = true;
    };
  }, [chainService, chainId, transaction]);

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
    <Section>
      <InfoSectionHeader>
        <Heading>
          <Title>Gas</Title>
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
                value={formatUnits(gas.networkFeePerGas, 'gwei')}
                unit="gwei"
              />
            ) : gas ? (
              'Unavailable'
            ) : (
              <LoadingSpinner />
            )}
          </RateTag>
        </Heading>
        <DetailsButton
          aria-label="Gas details"
          aria-haspopup="dialog"
          onClick={() => setShowDetails(true)}
        >
          <IonIcon icon={info} aria-hidden="true" />
        </DetailsButton>
      </InfoSectionHeader>
      {showFees && (
        <InfoTable aria-label="Gas fees">
          <tbody>
            <InfoTableSummary>
              <th scope="row">Expected fee</th>
              <td>
                {expectedFee !== undefined ? (
                  <NativeAmount value={expectedFee} currency={currency} />
                ) : gas ? (
                  'Unavailable'
                ) : (
                  <LoadingSpinner />
                )}
              </td>
            </InfoTableSummary>
            <InfoTableSummary>
              <th scope="row">Max. fee</th>
              <td>
                <NativeAmount value={maximumFee} currency={currency} />
              </td>
            </InfoTableSummary>
          </tbody>
        </InfoTable>
      )}
      {showDetails && (
        <CenteredPopup
          aria-label="Gas details"
          initialFocus="dialog"
          onDismiss={() => setShowDetails(false)}
        >
          <InfoSectionTitle>Gas details</InfoSectionTitle>
          <InfoSection>
            <InfoSectionRow>
              <InfoSectionItemLabel>
                {eip1559 ? 'Current base fee' : 'Current gas price'}
              </InfoSectionItemLabel>
              <DetailValue>
                {gas?.networkFeePerGas !== undefined
                  ? `${formatUnits(gas.networkFeePerGas, 'gwei')} gwei`
                  : gas
                    ? 'Unavailable'
                    : 'Loading…'}
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
                        : !currentHistory || (window && !gas)
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
          </InfoSection>
          {onChange ? (
            <EvmGasEditor
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
            <InfoSection>
              <InfoSectionRow>
                <InfoSectionItemLabel>Gas limit</InfoSectionItemLabel>
                <DetailValue>
                  {transaction.gasLimit.toLocaleString('en-US')}
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
            </InfoSection>
          )}
          <Note>Additional network fees are not included.</Note>
        </CenteredPopup>
      )}
    </Section>
  );
};
