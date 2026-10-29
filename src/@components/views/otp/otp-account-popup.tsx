import {type ReactNode, useState} from 'react';

import {type OTPImportAccount, parseOTPURI} from '../../../@lib/otp.js';
import {Button, Buttons} from '../../@ui/button.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from '../../@ui/details-popup.js';
import {InfoSectionItem, InfoSectionItemLabel} from '../../@ui/info-section.js';
import {PopupInput, PopupNumberInput} from '../../@ui/input.js';
import {InfoMessage} from '../../@ui/message-content.js';
import {SegmentedControl} from '../../@ui/segmented-control.js';

export function OTPAccountPopup({
  initialURI,
  onSave,
  onDismiss,
}: {
  initialURI?: string;
  onSave: (account: OTPImportAccount) => void;
  onDismiss: () => void;
}): ReactNode {
  const [initial] = useState(() => {
    if (!initialURI) return undefined;
    const {secret, ...metadata} = parseOTPURI(initialURI);
    secret.fill(0);
    return metadata;
  });
  const [label, setLabel] = useState(initial?.label ?? '');
  const [secret, setSecret] = useState(() =>
    initialURI ? (new URL(initialURI).searchParams.get('secret') ?? '') : '',
  );
  const [algorithm, setAlgorithm] = useState(initial?.algorithm ?? 'SHA1');
  const [digits, setDigits] = useState<'6' | '8'>(
    initial?.digits === 8 ? '8' : '6',
  );
  const [period, setPeriod] = useState(String(initial?.period ?? 30));
  const [error, setError] = useState<string>();

  function save(): void {
    try {
      const uri = new URL(`otpauth://totp/${encodeURIComponent(label.trim())}`);
      uri.search = new URLSearchParams({
        secret,
        algorithm,
        digits,
        period,
      }).toString();
      onSave(parseOTPURI(uri.toString()));
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Invalid OTP account');
    }
  }

  return (
    <DetailsPopup aria-label="Add OTP account" onDismiss={onDismiss}>
      <DetailsPopupTitle>Add account</DetailsPopupTitle>
      <DetailsPopupDivider />
      <InfoSectionItem as="label">
        <InfoSectionItemLabel>Name</InfoSectionItemLabel>
        <PopupInput
          aria-label="Account name"
          value={label}
          onChange={event => setLabel(event.target.value)}
          autoComplete="off"
        />
      </InfoSectionItem>
      <InfoSectionItem as="label">
        <InfoSectionItemLabel>Secret</InfoSectionItemLabel>
        <PopupInput
          aria-label="OTP secret"
          type="password"
          value={secret}
          onChange={event => setSecret(event.target.value)}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </InfoSectionItem>
      <InfoSectionItem>
        <InfoSectionItemLabel>Algorithm</InfoSectionItemLabel>
        <SegmentedControl
          aria-label="Algorithm"
          value={algorithm}
          options={[
            {value: 'SHA1', label: 'SHA-1'},
            {value: 'SHA256', label: 'SHA-256'},
            {value: 'SHA512', label: 'SHA-512'},
          ]}
          onChange={setAlgorithm}
        />
      </InfoSectionItem>
      <InfoSectionItem>
        <InfoSectionItemLabel>Digits</InfoSectionItemLabel>
        <SegmentedControl
          aria-label="Digits"
          value={digits}
          options={[
            {value: '6', label: '6'},
            {value: '8', label: '8'},
          ]}
          onChange={setDigits}
        />
      </InfoSectionItem>
      <InfoSectionItem as="label">
        <InfoSectionItemLabel>Period (seconds)</InfoSectionItemLabel>
        <PopupNumberInput
          aria-label="Period in seconds"
          inputMode="numeric"
          value={period}
          onChange={event => setPeriod(event.target.value)}
        />
      </InfoSectionItem>
      {error && <InfoMessage>{error}</InfoMessage>}
      <Buttons>
        <Button disabled={!label.trim() || !secret.trim()} onClick={save}>
          Add to card
        </Button>
      </Buttons>
    </DetailsPopup>
  );
}
