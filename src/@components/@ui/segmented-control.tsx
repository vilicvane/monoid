import {type ReactNode, useId} from 'react';
import {styled} from 'styled-components';

const Container = styled.div`
  margin: 0 -2px;
  display: flex;
  gap: 4px;
  padding: 2px;
  border: solid 0.5px var(--color-segmented-border);
  border-radius: 999px;
`;

const Option = styled.label`
  position: relative;
  flex: 1;
  min-width: 0;
  cursor: pointer;
`;

const OptionInput = styled.input`
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;

  &:checked + span {
    background-color: var(--color-segmented-selected);
    color: var(--color-segmented-selected-contrast);
  }

  &:focus-visible + span {
    outline: 2px solid var(--ion-color-primary);
    outline-offset: -2px;
  }
`;

const OptionLabel = styled.span`
  min-height: 26px;
  padding: 3px 4px;
  border-radius: 999px;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;

  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  text-align: center;

  @media (pointer: coarse) {
    min-height: 34px;
  }
`;

const OptionIcon = styled.span`
  display: flex;
  flex-shrink: 0;
`;

export const SegmentedControl = <Value extends string>({
  value,
  options,
  onChange,
  'aria-label': ariaLabel,
}: {
  value: Value;
  options: readonly {value: Value; label: ReactNode; icon?: ReactNode}[];
  onChange: (value: Value) => void;
  'aria-label': string;
}): ReactNode => {
  const name = useId();

  return (
    <Container role="radiogroup" aria-label={ariaLabel}>
      {options.map(option => (
        <Option key={option.value}>
          <OptionInput
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <OptionLabel>
            {option.icon && <OptionIcon aria-hidden>{option.icon}</OptionIcon>}
            {option.label}
          </OptionLabel>
        </Option>
      ))}
    </Container>
  );
};
