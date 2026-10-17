import classNames from 'classNames';
import type {ButtonHTMLAttributes, ReactNode} from 'react';
import {css, styled} from 'styled-components';

import {selectionTransition} from '../@animations.js';

import {RippleEffect} from './ripple-effect.js';

type IconButtonFeedback = 'ripple' | 'color';

const Container = styled.button<{$feedback: IconButtonFeedback}>`
  position: relative;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;

  display: inline-flex;
  align-items: center;
  justify-content: center;

  background: transparent;
  color: var(--ion-color-primary);
  font-size: 18px;

  &:disabled {
    color: var(--ion-color-medium-tint);
  }

  ${({$feedback}) =>
    $feedback === 'ripple'
      ? css`
          border-radius: 50%;
          overflow: hidden;
        `
      : css`
          color: var(--ion-color-medium-shade);
          -webkit-tap-highlight-color: transparent;
          transition: color ${selectionTransition.duration}ms
            ${selectionTransition.easing};

          &:active:not(:disabled) {
            color: var(--ion-color-primary);
            transition: none;
          }

          @media (prefers-reduced-motion: reduce) {
            transition: none;
          }
        `}
`;

export const IconButton = ({
  className,
  disabled,
  children,
  feedback = 'ripple',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  'aria-label': string;
  feedback?: IconButtonFeedback;
}): ReactNode => (
  <Container
    type="button"
    className={classNames(className, {
      'ion-activatable': feedback === 'ripple',
    })}
    $feedback={feedback}
    disabled={disabled}
    {...props}
  >
    {children}
    {!disabled && feedback === 'ripple' && <RippleEffect />}
  </Container>
);
