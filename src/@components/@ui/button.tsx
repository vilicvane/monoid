import {IonRippleEffect} from '@ionic/react';
import classNames from 'classNames';
import type {HTMLAttributes, ReactNode} from 'react';
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
`;

export const Button = ({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLButtonElement>): ReactNode => {
  return (
    <Container className={classNames(className, 'ion-activatable')} {...props}>
      {children}
      <IonRippleEffect />
    </Container>
  );
};
