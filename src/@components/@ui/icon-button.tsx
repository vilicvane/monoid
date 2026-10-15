import classNames from 'classNames';
import type {ButtonHTMLAttributes, ReactNode} from 'react';
import {styled} from 'styled-components';

import {RippleEffect} from './ripple-effect.js';

const Container = styled.button`
  position: relative;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  overflow: hidden;

  display: inline-flex;
  align-items: center;
  justify-content: center;

  background: transparent;
  color: var(--ion-color-primary);
  font-size: 18px;

  &:disabled {
    color: var(--ion-color-medium-tint);
  }
`;

export const IconButton = ({
  className,
  disabled,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  'aria-label': string;
}): ReactNode => (
  <Container
    type="button"
    className={classNames(className, 'ion-activatable')}
    disabled={disabled}
    {...props}
  >
    {children}
    {!disabled && <RippleEffect />}
  </Container>
);
