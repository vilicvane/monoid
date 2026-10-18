import classNames from 'classNames';
import {Check as check} from 'lucide-react';
import type {InputHTMLAttributes, ReactNode} from 'react';
import {styled} from 'styled-components';
import {UnmountAnimationClone} from 'unmount-animation-clone';

import {fadeOutAnimationCSS} from '../@animations.js';
import {AppIcon} from '../@ui/app-icon.js';

import {KeyTag} from './key-tags.js';

export const KeySelection = styled(KeyTag)`
  position: relative;
  width: 22px;
  padding: 0;

  display: flex;
  align-items: center;
  justify-content: center;

  background-color: var(--ion-color-dark-contrast);
  border-color: var(--ion-color-medium-tint);

  transition: all 0.2s linear;

  &.checked {
    background-color: var(--ion-color-primary);
    border-color: var(--ion-color-primary-shade);
    color: var(--ion-color-primary-contrast);
  }

  &:has(input:focus-visible) {
    outline: 2px solid var(--ion-color-primary);
    outline-offset: 2px;
  }

  &.up-to-date,
  &:has(input:disabled) {
    background-color: var(--ion-color-light);
    border-color: var(--ion-color-light-shade);
    color: var(--ion-color-medium-tint);
  }
`;

const Input = styled.input`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
`;

const Count = styled.span`
  position: absolute;

  &.unmount {
    ${fadeOutAnimationCSS}
    animation-duration: 120ms;
    pointer-events: none;
  }

  @media (prefers-reduced-motion: reduce) {
    &.unmount {
      animation-duration: 0s;
    }
  }
`;

export const KeyCheckbox = ({
  checked,
  className,
  count,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  count?: number;
}): ReactNode => (
  <KeySelection
    className={classNames(className, {checked: count === undefined && checked})}
    aria-hidden={count === undefined ? undefined : true}
  >
    {count === undefined ? (
      <>
        <Input {...props} type="checkbox" checked={checked} />
        {checked && <AppIcon icon={check} aria-hidden="true" />}
      </>
    ) : (
      <UnmountAnimationClone>
        <Count>{count}</Count>
      </UnmountAnimationClone>
    )}
  </KeySelection>
);
