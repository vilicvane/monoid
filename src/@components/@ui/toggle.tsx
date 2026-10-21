import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {selectionTransition} from '../@animations.js';

const Container = styled.button`
  width: 100%;
  min-height: 44px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--ion-color-dark);
  font: inherit;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;

  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;

  &:disabled {
    cursor: default;
    opacity: 0.5;
  }

  &:focus-visible {
    outline: 2px solid var(--ion-color-primary);
    outline-offset: 3px;
  }
`;

const Label = styled.span`
  min-width: 0;
`;

const Track = styled.span<{$checked: boolean}>`
  box-sizing: border-box;
  flex-shrink: 0;
  width: 42px;
  height: 24px;
  padding: 3px;
  border-radius: 999px;
  background: ${props =>
    props.$checked
      ? 'var(--ion-color-primary)'
      : 'var(--ion-color-light-shade)'};
  transition: background-color ${selectionTransition.duration}ms linear;

  &::before {
    content: '';
    display: block;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--ion-color-primary-contrast);
    transform: translateX(${props => (props.$checked ? 18 : 0)}px);
    transition: transform ${selectionTransition.duration}ms
      ${selectionTransition.easing};
  }

  @media (prefers-reduced-motion: reduce) {
    &,
    &::before {
      transition: none;
    }
  }
`;

export function Toggle({
  checked,
  onChange,
  children,
  disabled = false,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}): ReactNode {
  return (
    <Container
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={className}
      onClick={() => onChange(!checked)}
    >
      <Label>{children}</Label>
      <Track $checked={checked} aria-hidden="true" />
    </Container>
  );
}
