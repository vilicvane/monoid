import classNames from 'classNames';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteClass__} from 'routra';
import {styled} from 'styled-components';

import {navigationTransition} from '../@animations.js';
import {useAnimationHint} from '../@hooks/use-animation-hint.js';
import {AppIcon, type AppIconSource} from '../@ui/app-icon.js';
import {IndicatorDot} from '../@ui/indicator-dot.js';
import {NumberBadge} from '../@ui/number-badge.js';
import {RippleEffect as RippleEffect_} from '../@ui/ripple-effect.js';

export const Container = styled.button`
  position: relative;

  border: 0;
  padding: 0;
  background: transparent;

  display: flex;
  align-items: center;
  justify-content: center;

  font-size: var(--nav-bar-icon-size, 20px);
  color: var(--ion-color-medium);

  transition: color 0.2s linear;

  &.active {
    color: var(--ion-color-dark);
  }

  &:focus-visible {
    outline: 2px solid var(--ion-color-primary);
    outline-offset: -4px;
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

const ActiveDot = styled(IndicatorDot)`
  position: absolute;

  bottom: 0;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%) scale(0);
  margin-top: 18px;
  background-color: var(--ion-color-medium-tint);
  opacity: 0;

  transition:
    background-color 0.1s linear,
    opacity 0.1s linear,
    transform 0.1s ease-in-out;

  ${Container}.active & {
    transform: translate(-50%, -50%) scale(1);
    opacity: 1;
    transition-delay:
      0s, var(--nav-dot-delay, ${navigationTransition.duration}ms),
      var(--nav-dot-delay, ${navigationTransition.duration}ms);
  }

  ${Container}.exact-active & {
    background-color: var(--ion-color-primary);
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

const Badge = styled(NumberBadge)<{$visible: boolean}>`
  position: absolute;
  top: calc(50% - 16px);
  left: calc(50% + 3px);
  z-index: 1;
  pointer-events: none;
  will-change: transform, opacity;
  opacity: ${props => (props.$visible ? 1 : 0)};
  transform: scale(${props => (props.$visible ? 1 : 0)});

  transition:
    opacity 0.1s ease-out,
    transform 0.1s ease-out;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

const RippleEffect = styled(RippleEffect_)`
  left: 50%;
  right: auto;
  width: var(--nav-tab-ripple-width, calc(100% + 40px));
  margin-top: calc(var(--view-inset-bottom) / 2);
  transform: translateX(-50%);
`;

export const Tab = observer(
  ({
    className,
    icon,
    label,
    badge,
    route,
    inert,
    activity,
  }: {
    className?: string;
    icon: AppIconSource;
    label: string;
    badge?: number;
    route: RouteClass__;
    inert?: boolean;
    activity: '$active' | '$transition';
  }): ReactNode => {
    const active = !!route[activity];
    const exactActive = !!route.$exact[activity];
    const badgeVisible = badge !== undefined && badge > 0 && !exactActive;
    const tabRef = useAnimationHint<HTMLButtonElement>(inert);
    const dotRef = useAnimationHint<HTMLDivElement>(active);

    return (
      <Container
        ref={tabRef}
        type="button"
        inert={inert}
        aria-label={badgeVisible ? `${label}, ${badge}` : label}
        aria-current={active ? 'page' : undefined}
        className={classNames('ion-activatable', className, {
          active,
          'exact-active': exactActive,
        })}
        onClick={() => route.$reset()}
      >
        <ActiveDot ref={dotRef} />
        <AppIcon icon={icon} aria-hidden="true" />
        {badge !== undefined && (
          <Badge $visible={badgeVisible} aria-hidden="true">
            {badge}
          </Badge>
        )}
        <RippleEffect type="unbounded" />
      </Container>
    );
  },
);
