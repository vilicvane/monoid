import {IonIcon} from '@ionic/react';
import classNames from 'classNames';
import check from 'lucide-static/icons/check.svg';
import type {InputHTMLAttributes, ReactNode} from 'react';
import {styled} from 'styled-components';
import {UnmountAnimationClone} from 'unmount-animation-clone';

import {fadeOutAnimationCSS} from '../@animations.js';

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

  &.up-to-date {
    background-color: var(--ion-color-light);
    border-color: var(--ion-color-light-shade);
    color: var(--ion-color-medium-tint);
  }

  &.checked {
    background-color: var(--ion-color-primary);
    border-color: var(--ion-color-primary-shade);
    color: var(--ion-color-primary-contrast);
  }

  &:has(input:focus-visible) {
    outline: 2px solid var(--ion-color-primary);
    outline-offset: 2px;
  }

  &:has(input:disabled) {
    opacity: 0.5;
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
        {checked && <IonIcon icon={check} aria-hidden="true" />}
      </>
    ) : (
      <UnmountAnimationClone>
        <Count>{count}</Count>
      </UnmountAnimationClone>
    )}
  </KeySelection>
);
