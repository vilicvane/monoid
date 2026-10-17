import {formatUnits, parseUnits} from 'ethers';
import {type ReactNode, useEffect, useId, useState} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import type {NativeCurrency} from '../../@lib/chain-names.js';
import {
  type EvmGasPresets,
  type EvmGasSettings,
  assertEvmGasSettings,
  getEvmGasPresets,
} from '../../@lib/evm-gas-settings.js';
import {
  type EvmGasTransaction,
  getExpectedEvmGasFee,
} from '../../@lib/evm-gas.js';

import {Button} from './button.js';
import {
  InfoSection,
  InfoSectionItemLabel,
  InfoSectionRow,
} from './info-section.js';
import {PopupNumberInput} from './input.js';
import {NativeAmount} from './native-amount.js';
import {SegmentedControl} from './segmented-control.js';

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 16px;
`;

const FieldRow = styled(InfoSectionRow)`
  align-items: center;
`;

const FieldValue = styled(PopupNumberInput)`
  text-align: right;
`;

const ErrorMessage = styled.div`
  color: var(--ion-color-warning);
  font-size: 12px;
`;

const Amount = styled.span`
  max-width: 100%;
  overflow-wrap: anywhere;
`;

type GasDraft = Record<keyof EvmGasSettings, string>;

function getDraft(settings: EvmGasSettings): GasDraft {
  return {
    gasLimit: settings.gasLimit.toString(),
    gasPrice: formatUnits(settings.gasPrice ?? BigInt(0), 'gwei'),
    maxFeePerGas: formatUnits(settings.maxFeePerGas ?? BigInt(0), 'gwei'),
    maxPriorityFeePerGas: formatUnits(
      settings.maxPriorityFeePerGas ?? BigInt(0),
      'gwei',
    ),
  };
}

function parseDraft(
  draft: GasDraft,
  type: EvmGasTransaction['type'],
  minimum?: EvmGasSettings,
):
  | {settings: EvmGasSettings; error?: never}
  | {settings?: never; error: string} {
  try {
    if (!/^\d+$/.test(draft.gasLimit.trim())) {
      throw new Error('Enter a positive whole-number gas limit.');
    }
    const parseFee = (value: string): bigint => {
      if (!/^(?:\d+(?:\.\d{0,9})?|\.\d{1,9})$/.test(value.trim())) {
        throw new Error('Enter a fee with up to 9 decimal places.');
      }
      return parseUnits(value.trim(), 'gwei');
    };
    const settings: EvmGasSettings = {
      gasLimit: BigInt(draft.gasLimit.trim()),
      gasPrice: type === 2 ? null : parseFee(draft.gasPrice),
      maxFeePerGas: type === 2 ? parseFee(draft.maxFeePerGas) : null,
      maxPriorityFeePerGas:
        type === 2 ? parseFee(draft.maxPriorityFeePerGas) : null,
    };
    assertEvmGasSettings({...settings, type});
    if (minimum) {
      const fields =
        type === 2
          ? (['maxFeePerGas', 'maxPriorityFeePerGas'] as const)
          : (['gasPrice'] as const);
      for (const field of fields) {
        if (settings[field]! < minimum[field]!) {
          throw new Error(
            `Replacement fees must be at least ${formatUnits(minimum[field]!, 'gwei')} gwei.`,
          );
        }
      }
      if (settings.gasLimit < minimum.gasLimit)
        throw new Error(`Gas limit must be at least ${minimum.gasLimit}.`);
    }
    return {settings};
  } catch (error) {
    return {error: (error as Error).message};
  }
}

export const EvmGasEditor = ({
  chainId,
  transaction,
  networkFeePerGas,
  currency,
  onApply,
  minimum,
}: {
  chainId: string;
  transaction: EvmGasTransaction;
  networkFeePerGas?: bigint;
  currency?: NativeCurrency;
  onApply: (settings: EvmGasSettings) => void;
  minimum?: EvmGasSettings;
}): ReactNode => {
  const {chainService} = useEntrances();
  const id = useId();
  const [draft, setDraft] = useState(() => getDraft(transaction));
  const [selectedPreset, setSelectedPreset] = useState<keyof EvmGasPresets>();
  const [options, setOptions] = useState<{
    presets?: EvmGasPresets;
  }>();
  const {settings, error} = parseDraft(draft, transaction.type, minimum);
  const eip1559 = transaction.type === 2;
  const changed =
    settings &&
    Object.keys(settings).some(
      key =>
        settings[key as keyof EvmGasSettings] !==
        transaction[key as keyof EvmGasSettings],
    );
  const matches = Object.entries(options?.presets ?? {})
    .filter(
      ([, preset]) =>
        settings &&
        preset.gasPrice === settings.gasPrice &&
        preset.maxFeePerGas === settings.maxFeePerGas &&
        preset.maxPriorityFeePerGas === settings.maxPriorityFeePerGas,
    )
    .map(([name]) => name);
  const selected =
    selectedPreset && matches.includes(selectedPreset)
      ? selectedPreset
      : matches[0];
  const maximumFee =
    settings &&
    settings.gasLimit * (settings.maxFeePerGas ?? settings.gasPrice!);
  const expectedFee =
    settings &&
    getExpectedEvmGasFee(
      {...settings, type: transaction.type},
      networkFeePerGas,
    );

  useEffect(() => {
    let cancelled = false;

    void chainService
      .getRPC(chainId)
      .then(provider => getEvmGasPresets(transaction, provider))
      .then(presets => {
        if (minimum) {
          for (const preset of Object.values(presets)) {
            for (const field of [
              'gasPrice',
              'maxFeePerGas',
              'maxPriorityFeePerGas',
            ] as const) {
              if (
                preset[field] != null &&
                minimum[field] != null &&
                preset[field]! < minimum[field]!
              )
                preset[field] = minimum[field];
            }
            if (
              preset.maxFeePerGas != null &&
              preset.maxPriorityFeePerGas! > preset.maxFeePerGas
            )
              preset.maxFeePerGas = preset.maxPriorityFeePerGas;
          }
        }
        if (!cancelled) setOptions({presets});
      })
      .catch(() => {
        if (!cancelled) setOptions({});
      });

    return () => {
      cancelled = true;
    };
  }, [chainService, chainId, transaction, minimum]);

  const fields: {key: keyof GasDraft; label: string; unit?: string}[] = [
    {key: 'gasLimit', label: 'Gas limit'},
    ...(eip1559
      ? [
          {
            key: 'maxFeePerGas' as const,
            label: 'Max. fee per gas',
            unit: 'gwei',
          },
          {
            key: 'maxPriorityFeePerGas' as const,
            label: 'Max. priority fee',
            unit: 'gwei',
          },
        ]
      : [{key: 'gasPrice' as const, label: 'Gas price', unit: 'gwei'}]),
  ];

  return (
    <Form
      aria-label="Edit gas"
      onSubmit={event => {
        event.preventDefault();
        if (settings && changed) onApply(settings);
      }}
    >
      <SegmentedControl
        disabled={!options?.presets}
        aria-label="Gas options"
        value={selected ?? 'custom'}
        options={[
          {value: 'economy', label: 'Economy'},
          {value: 'standard', label: 'Standard'},
          {value: 'fast', label: 'Fast'},
        ]}
        onChange={value => {
          const preset = options!.presets![value as keyof EvmGasPresets];
          setSelectedPreset(value as keyof EvmGasPresets);
          setDraft(current => ({
            ...getDraft(preset),
            gasLimit: current.gasLimit,
          }));
        }}
      />
      <InfoSection>
        {fields.map(({key, label, unit}) => (
          <FieldRow key={key}>
            <InfoSectionItemLabel as="label" htmlFor={`${id}-${key}`}>
              {label}
              {unit && ` (${unit})`}
            </InfoSectionItemLabel>
            <FieldValue
              id={`${id}-${key}`}
              name={key}
              inputMode={unit ? 'decimal' : 'numeric'}
              autoComplete="off"
              spellCheck={false}
              value={draft[key]}
              aria-invalid={!!error}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={event =>
                setDraft(current => ({...current, [key]: event.target.value}))
              }
            />
          </FieldRow>
        ))}
      </InfoSection>
      {error && (
        <ErrorMessage id={`${id}-error`} role="status">
          {error}
        </ErrorMessage>
      )}
      <InfoSection aria-label="Updated gas fees">
        <InfoSectionRow>
          <InfoSectionItemLabel>Expected fee</InfoSectionItemLabel>
          <Amount>
            {expectedFee === undefined ? (
              'Unavailable'
            ) : (
              <NativeAmount value={expectedFee} currency={currency} />
            )}
          </Amount>
        </InfoSectionRow>
        <InfoSectionRow>
          <InfoSectionItemLabel>Max. fee</InfoSectionItemLabel>
          <Amount>
            {maximumFee === undefined ? (
              'Unavailable'
            ) : (
              <NativeAmount value={maximumFee} currency={currency} />
            )}
          </Amount>
        </InfoSectionRow>
      </InfoSection>
      <Button type="submit" disabled={!changed}>
        Apply
      </Button>
    </Form>
  );
};
