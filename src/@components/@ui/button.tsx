import classNames from 'classNames';
import type {ButtonHTMLAttributes, ReactNode} from 'react';
import {styled} from 'styled-components';

import {RippleEffect} from './ripple-effect.js';

const Container = styled.button`
  position: relative;

  height: 40px;

  background-color: var(--ion-color-primary);
  border: solid 0.5px var(--ion-color-primary-shade);
  color: var(--ion-color-primary-contrast);
  border-radius: 20px;
  font-size: 16px;

  transition: all 0.2s linear;

  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;

  &:disabled {
    background-color: transparent;
    border-color: var(--ion-color-light-shade);
    color: var(--ion-color-medium-tint);
  }
`;

export const Button = ({
  className,
  disabled,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>): ReactNode => {
  return (
    <Container
      className={classNames(className, 'ion-activatable')}
      disabled={disabled}
      {...props}
    >
      {children}
      {!disabled && <RippleEffect />}
    </Container>
  );
};

export const Buttons = styled.div`
  margin: auto -2px 0;

  display: flex;
  flex-direction: column;
  gap: 8px;
`;
