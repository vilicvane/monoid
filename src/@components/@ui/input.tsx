import {IonIcon} from '@ionic/react';
import rotateCcw from 'lucide-static/icons/rotate-ccw.svg';
import {type InputHTMLAttributes, type ReactNode, useRef} from 'react';
import {styled} from 'styled-components';

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
