import {type ReactNode, useId} from 'react';
import {css, styled} from 'styled-components';

import {selectionTransition} from '../@animations.js';

type OptionColor = 'safe' | 'danger';

const Container = styled.div<{
  $count: number;
  $index: number;
  $color?: OptionColor;
}>`
  position: relative;
  margin: 0 -2px;
  display: flex;
  gap: 4px;
  padding: 2px;
  border: solid 0.5px var(--color-segmented-border);
  border-radius: 999px;

  &::before {
    content: '';
    position: absolute;
    top: 2px;
    bottom: 2px;
    left: 2px;
    width: calc(100% / ${({$count}) => $count} - 4px);
    border-radius: inherit;
    background-color: ${({$color}) =>
      $color
        ? `var(--ion-color-${$color})`
        : 'var(--color-segmented-selected)'};
    transform: translateX(
      calc(
        ${({$index}) => Math.max(0, $index) * 100}% +
          ${({$index}) => Math.max(0, $index) * 4}px
      )
    );
    opacity: ${({$index}) => ($index < 0 ? 0 : 1)};
    pointer-events: none;
    transition:
      transform ${selectionTransition.duration}ms ${selectionTransition.easing},
      opacity ${selectionTransition.duration}ms ${selectionTransition.easing},
      background-color ${selectionTransition.duration}ms linear;
  }

  @media (prefers-reduced-motion: reduce) {
    &::before {
      transition: none;
    }
  }
`;

const Option = styled.label<{$color?: OptionColor}>`
  position: relative;
  flex: 1;
  min-width: 0;
  cursor: pointer;

  &:has(input:disabled) {
    cursor: default;
  }

  ${({$color}) =>
    $color &&
    css`
      --color-segmented-selected-contrast: var(--ion-color-${$color}-contrast);
    `}
`;

const OptionInput = styled.input`
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;

  &:checked + span {
    color: var(--color-segmented-selected-contrast);
  }

  &:disabled + span {
    color: var(--color-text-dim);
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
  transition: color ${selectionTransition.duration}ms linear;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }

  @media (pointer: coarse) {
    min-height: 34px;
  }
`;

const OptionIcon = styled.span`
  display: flex;
  flex-shrink: 0;
`;

type SegmentedControlProps<Value extends string> = {
  options: readonly {
    value: Value;
    label: ReactNode;
    icon?: ReactNode;
    color?: OptionColor;
  }[];
  disabled?: boolean;
  'aria-label': string;
} & (
  | {
      allowDeselect: true;
      value: Value | undefined;
      onChange: (value: Value | undefined) => void;
    }
  | {
      allowDeselect?: false;
      value: Value;
      onChange: (value: Value) => void;
    }
);

export const SegmentedControl = <Value extends string>({
  value,
  options,
  onChange,
  allowDeselect,
  disabled = false,
  'aria-label': ariaLabel,
}: SegmentedControlProps<Value>): ReactNode => {
  const name = useId();
  const selectedIndex = options.findIndex(option => option.value === value);

  return (
    <Container
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled}
      $count={options.length || 1}
      $index={selectedIndex}
      $color={options[selectedIndex]?.color}
    >
      {options.map(option => (
        <Option key={option.value} $color={option.color}>
          <OptionInput
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            onClick={() => {
              if (allowDeselect && value === option.value) onChange(undefined);
            }}
            onKeyDown={event => {
              if (
                allowDeselect &&
                value === option.value &&
                event.key === ' '
              ) {
                event.preventDefault();
                onChange(undefined);
              }
            }}
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
