import {IonRippleEffect} from '@ionic/react';
import classNames from 'classNames';
import type {ButtonHTMLAttributes, ReactNode} from 'react';
import {styled} from 'styled-components';

const Container = styled.button`
  margin: 0 -2px;

  position: relative;

  height: 40px;

  background-color: var(--ion-color-primary);
  border: solid 0.5px var(--ion-color-primary-shade);
  color: var(--ion-color-primary-contrast);
  border-radius: 8px;
  font-size: 16px;

  transition: all 0.2s linear;

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
      {!disabled && <IonRippleEffect />}
    </Container>
  );
};
