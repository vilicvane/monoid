import {IonIcon} from '@ionic/react';
import rotateCcw from 'lucide-static/icons/rotate-ccw.svg';
import {type InputHTMLAttributes, type ReactNode, useRef} from 'react';
import {styled} from 'styled-components';

import {selectionTransition} from '../@animations.js';

export const Input = styled.input`
  border: solid 0.5px var(--ion-color-light-shade);
  box-sizing: content-box;
  height: 20px;
  padding: 8px 12px;
  align-self: stretch;

  border-radius: 4px;
  outline-color: var(--ion-color-primary);

  transition: color 0.2s linear;

  &:not(:focus) {
    color: var(--color-text-secondary);
  }

  &[aria-invalid='true'] {
    border-color: var(--ion-color-danger);
    outline-color: var(--ion-color-danger);
  }
`;

export const PopupInput = styled(Input)`
  field-sizing: content;
  width: auto;
  min-width: 0;
  max-width: 100%;
  padding: 4px 0;
  border: none;
  border-bottom: solid 0.5px var(--color-segmented-border);
  border-radius: 0;
  background: transparent;
  color: inherit;
  font-size: 16px;
  outline: none;
  transition:
    color ${selectionTransition.duration}ms linear,
    min-width ${selectionTransition.duration}ms ${selectionTransition.easing},
    border-bottom-color ${selectionTransition.duration}ms linear,
    border-bottom-width ${selectionTransition.duration}ms
      ${selectionTransition.easing},
    padding-bottom ${selectionTransition.duration}ms
      ${selectionTransition.easing};

  &:focus {
    min-width: min(2ch, 100%);
    border-bottom-width: 1px;
    padding-bottom: 3.5px;
  }

  &:focus:not([aria-invalid='true']) {
    border-bottom-color: currentColor;
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

export const PopupNumberInput = (
  props: InputHTMLAttributes<HTMLInputElement>,
): ReactNode => (
  <PopupInput
    {...props}
    onFocus={event => {
      props.onFocus?.(event);
      const input = event.currentTarget;
      requestAnimationFrame(() => {
        if (document.activeElement !== input) return;
        const start = input.value.search(/[1-9]/);
        input.setSelectionRange(
          start < 0 ? input.value.length : start,
          input.value.length,
        );
      });
    }}
  />
);

const InputContainer = styled.div`
  position: relative;
  display: flex;
  align-self: stretch;

  ${Input} {
    flex: 1;
    min-width: 0;
    padding-right: 40px;
  }
`;

const ResetButton = styled.button<{$invalid: boolean}>`
  position: absolute;
  top: 0;
  right: 4px;
  bottom: 0;
  width: 32px;
  padding: 0;

  display: flex;
  align-items: center;
  justify-content: center;

  border: none;
  background: transparent;
  font-size: 16px;
  color: ${({$invalid}) =>
    $invalid ? 'var(--ion-color-danger)' : 'var(--ion-color-primary)'};

  &:disabled {
    color: var(--ion-color-medium-tint);
  }
`;

export const ResettableInput = ({
  onReset,
  resetDisabled,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  onReset: () => void;
  resetDisabled: boolean;
}): ReactNode => {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <InputContainer>
      <Input {...props} ref={inputRef} />
      <ResetButton
        type="button"
        aria-label="Reset to default"
        title="Reset to default"
        disabled={resetDisabled || props.disabled}
        $invalid={
          props['aria-invalid'] === true || props['aria-invalid'] === 'true'
        }
        onClick={() => {
          onReset();
          inputRef.current?.focus();
        }}
      >
        <IonIcon icon={rotateCcw} aria-hidden="true" />
      </ResetButton>
    </InputContainer>
  );
};
