import {type ReactNode, useId, useState} from 'react';
import {styled} from 'styled-components';

import type {BitcoinFeeRates} from '../../../@lib/bitcoin-api.js';
import {Button} from '../../@ui/button.js';
import {
  InfoSection,
  InfoSectionItemLabel,
  InfoSectionRow,
} from '../../@ui/info-section.js';
import {PopupNumberInput} from '../../@ui/input.js';
import {InfoMessage} from '../../@ui/message-content.js';
import {SegmentedControl} from '../../@ui/segmented-control.js';

export type BitcoinFeeChoice = keyof BitcoinFeeRates | 'custom';

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

export function BitcoinFeeEditor({
  fees,
  feeError,
  choice,
  customFee,
  onApply,
}: {
  fees?: BitcoinFeeRates;
  feeError?: string;
  choice: BitcoinFeeChoice;
  customFee: string;
  onApply: (choice: BitcoinFeeChoice, customFee: string) => void;
}): ReactNode {
  const id = useId();
  const [draftFee, setDraftFee] = useState<string>();
  const [selectedPreset, setSelectedPreset] = useState<keyof BitcoinFeeRates>();
  const currentRate = choice === 'custom' ? Number(customFee) : fees?.[choice];
  const value =
    draftFee ??
    (choice === 'custom' ? customFee : (currentRate?.toString() ?? ''));
  const rate = Number(value);
  const valid =
    /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) &&
    Number.isFinite(rate) &&
    rate >= 1;
  const matches = (Object.keys(fees ?? {}) as (keyof BitcoinFeeRates)[]).filter(
    preset => valid && fees?.[preset] === rate,
  );
  const preferredPreset =
    selectedPreset ?? (choice !== 'custom' ? choice : undefined);
  const selected =
    preferredPreset && matches.includes(preferredPreset)
      ? preferredPreset
      : matches[0];
  const changed = valid && rate !== currentRate;
  const error =
    !valid && (draftFee !== undefined || choice === 'custom')
      ? 'Enter a fee rate of at least 1 sat/vB.'
      : undefined;

  return (
    <Form
      aria-label="Edit network fee"
      onSubmit={event => {
        event.preventDefault();
        if (changed) onApply(selected ?? 'custom', value);
      }}
    >
      <SegmentedControl<BitcoinFeeChoice>
        disabled={!fees}
        aria-label="Fee options"
        value={selected ?? 'custom'}
        options={[
          {value: 'economy', label: 'Economy'},
          {value: 'normal', label: 'Standard'},
          {value: 'fast', label: 'Fast'},
        ]}
        onChange={preset => {
          if (preset === 'custom') return;
          setSelectedPreset(preset);
          setDraftFee(fees![preset].toString());
        }}
      />
      <InfoSection>
        <FieldRow>
          <InfoSectionItemLabel as="label" htmlFor={id}>
            Fee rate (sat/vB)
          </InfoSectionItemLabel>
          <FieldValue
            id={id}
            name="feeRate"
            aria-label="Fee rate in satoshis per virtual byte"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={value}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
            placeholder={feeError ? 'Unavailable' : 'Loading…'}
            onChange={event => setDraftFee(event.target.value)}
          />
        </FieldRow>
      </InfoSection>
      {error && (
        <ErrorMessage id={`${id}-error`} role="status">
          {error}
        </ErrorMessage>
      )}
      {feeError && <InfoMessage>{feeError}</InfoMessage>}
      <Button type="submit" disabled={!changed}>
        Apply
      </Button>
    </Form>
  );
}
