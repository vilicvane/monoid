import {IonIcon} from '@ionic/react';
import classNames from 'classNames';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteClass__} from 'routra';
import {styled} from 'styled-components';

import {RippleEffect as RippleEffect_} from '../@ui/ripple-effect.js';

export const Container = styled.div`
  position: relative;

  display: flex;
  align-items: center;
  justify-content: center;

  font-size: 20px;
  color: var(--ion-color-medium);

  transition: color 0.2s linear;

  &.active {
    color: var(--ion-color-dark);
  }
`;

const ActiveDot = styled.div`
  position: absolute;

  bottom: 0;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%) scale(0);
  margin-top: 18px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--ion-color-medium-tint);
  opacity: 0;

  transition:
    background-color 0.2s linear,
    opacity 0.2s linear,
    transform 0.2s ease-in-out;

  ${Container}.active & {
    transform: translate(-50%, -50%) scale(1);
    opacity: 1;
  }

  ${Container}.exact-active & {
    background-color: var(--ion-color-primary);
  }
`;

const RippleEffect = styled(RippleEffect_)`
  margin: calc(var(--view-inset-bottom) / 2) -20px 0;
`;

export const Tab = observer(
  ({
    className,
    icon,
    route,
  }: {
    className?: string;
    icon: string;
    route: RouteClass__;
  }): ReactNode => {
    return (
      <Container
        className={classNames('ion-activatable', className, {
          active: route.$active,
          'exact-active': route.$exact.$active,
        })}
        onClick={() => route.$reset()}
      >
        <ActiveDot />
        <IonIcon icon={icon} />
        <RippleEffect type="unbounded" />
      </Container>
    );
  },
);
