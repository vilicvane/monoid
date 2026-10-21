import {type ReactNode, useState} from 'react';
import {styled} from 'styled-components';

import {Button, Buttons} from './button.js';
import {DetailsPopup, DetailsPopupTitle} from './details-popup.js';
import {InfoSectionItemContent} from './info-section.js';

const Description = styled(InfoSectionItemContent)`
  color: var(--color-text-secondary);
  font-size: 14px;
  line-height: 1.5;

  > p {
    margin: 0;
  }

  > p + p {
    margin-top: 12px;
  }

  > ol {
    margin: 12px 0 0;
    padding-inline-start: 20px;
  }

  > ol > li + li {
    margin-top: 12px;
  }
`;

export type ConfirmPopupProps = {
  title: string;
  children: ReactNode;
  confirmColor?: 'primary' | 'warning' | 'danger';
  confirmText?: string | readonly string[];
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmPopup({
  title,
  children,
  confirmColor = 'primary',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
}: ConfirmPopupProps): ReactNode {
  const [step, setStep] = useState(0);
  const labels = typeof confirmText === 'string' ? [confirmText] : confirmText;

  return (
    <DetailsPopup aria-label={title} initialFocus="dialog" onDismiss={onCancel}>
      <DetailsPopupTitle>{title}</DetailsPopupTitle>
      <Description>{children}</Description>
      <Buttons data-popup-animation-group>
        <Button
          type="button"
          color={confirmColor}
          onClick={() => {
            if (step + 1 < labels.length) setStep(step + 1);
            else onConfirm();
          }}
        >
          {labels[step] ?? 'Confirm'}
        </Button>
        <Button type="button" color="neutral" onClick={onCancel}>
          {cancelText}
        </Button>
      </Buttons>
    </DetailsPopup>
  );
}
