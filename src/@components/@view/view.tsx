import classNames from 'classNames';
import {observable} from 'mobx';
import {observer} from 'mobx-react-lite';
import type {CSSProperties, HTMLAttributes, ReactNode} from 'react';
import {useContext, useEffect, useState} from 'react';
import {RouteContext} from 'routra-react';
import {styled} from 'styled-components';

import type {ViewSwitchingState} from '../../@routes.js';
import {
  fadeInAnimationCSS,
  fadeOutAnimationCSS,
  slideInAnimationCSS,
  slideOutAnimationCSS,
} from '../@animations.js';

import {ViewContext} from './@view-context.js';
import {useSwipeBack} from './use-swipe-back.js';

const Container = styled.div`
  --view-padding: 16px;

  --view-padding-top: calc(var(--view-inset-top) + var(--view-padding));
  --view-padding-bottom: calc(
    var(--view-inset-bottom) + var(--nav-bar-height) + var(--view-padding)
  );

  position: absolute;
  z-index: var(--view-z-index);

  top: 0;
  left: 0;
  right: 0;
  bottom: 0;

  display: flex;
  flex-direction: column;

  background-color: var(--ion-color-primary-contrast);
  box-shadow: 1px 0 10px rgba(0, 0, 0, 0.2);

  &.animation {
    &.entering {
      ${fadeInAnimationCSS}

      z-index: var(--view-entering-z-index);
    }

    &.leaving {
      ${fadeOutAnimationCSS}
    }

    &.sliding {
      &.entering {
        ${slideInAnimationCSS}
      }

      &.leaving {
        ${slideOutAnimationCSS}

        --slide-offset: -25%;
      }

      &.back {
        &.entering {
          --slide-offset: -25%;
          z-index: var(--view-z-index);
        }

        &.leaving {
          --slide-offset: 100%;
          z-index: var(--view-entering-z-index);
        }
      }
    }

    @media (prefers-reduced-motion: reduce) {
      animation-duration: 1ms !important;
    }
  }

  &.switching-from,
  &.switching-to {
    /* Keep swipe layers stable near zero progress to avoid WebView buffer churn. */
    will-change: transform;
  }

  &.switching-from {
    z-index: var(--view-entering-z-index);
    transform: translateX(calc(var(--view-swipe-progress) * 100%));
  }

  &.switching-to {
    z-index: var(--view-z-index);
    transform: translateX(calc((var(--view-swipe-progress) - 1) * 25%));
    pointer-events: none;
  }

  &.settling {
    transition: transform 0.2s ease-out;

    @media (prefers-reduced-motion: reduce) {
      transition-duration: 1ms;
    }
  }
`;

export const View = observer(
  ({
    animation = true,
    className,
    children,
    style,
    ...props
  }: HTMLAttributes<HTMLDivElement> & {
    animation?: boolean;
    children: ReactNode;
  }): ReactNode => {
    const {view, transition} = useContext(RouteContext);
    const operation = (view.$entering ?? view.$leaving)?.$operation;
    const switching = view.$switching as
      | (NonNullable<typeof view.$switching> & ViewSwitchingState)
      | undefined;
    const swipeBack = useSwipeBack(view, animation);

    const [context] = useState(() =>
      observable({
        scrolled: false,
      }),
    );

    useEffect(
      () =>
        view.$transition({
          entering: animation,
          leaving: animation,
        }),
      [animation, view],
    );

    return (
      <Container
        {...props}
        ref={swipeBack.ref}
        className={classNames(className, {
          animation,
          entering: view.$entering,
          leaving: view.$leaving,
          sliding: operation === 'push' || typeof operation === 'number',
          back: typeof operation === 'number' && operation < 0,
          'switching-from': switching?.$rel === 'from',
          'switching-to': switching?.$rel === 'to',
          settling: switching?.settling,
        })}
        style={
          {
            ...style,
            '--view-swipe-progress': switching?.progress,
          } as CSSProperties
        }
        {...transition.events}
        onTransitionEnd={event => {
          transition.events.onTransitionEnd(event);
          swipeBack.onTransitionEnd(event);
        }}
      >
        <ViewContext.Provider value={context}>{children}</ViewContext.Provider>
      </Container>
    );
  },
);
