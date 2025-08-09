import {IonSpinner} from '@ionic/react';
import classNames from 'classNames';
import {
  type ButtonHTMLAttributes,
  type ReactNode,
  useCallback,
  useState,
} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';

import {RippleEffect} from './ripple-effect.js';

export const Buttons = styled.div`
  margin: auto -2px 0;

  display: flex;
  flex-direction: column;
  gap: 8px;
`;

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

export const AsyncButton = ({
  disabled,
  handler,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  handler: () => Promise<void>;
}): ReactNode => {
  const {errorService} = useEntrances();

  const [loading, setLoading] = useState(false);

  const onClick = useCallback(() => {
    setLoading(true);

    errorService.catch(handler().finally(() => setLoading(false)));
  }, [errorService, handler]);

  return (
    <Button {...props} disabled={disabled || loading} onClick={onClick}>
      {loading && <IonSpinner />}
      {children}
    </Button>
  );
};
