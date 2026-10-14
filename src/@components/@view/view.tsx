import classNames from 'classNames';
import {observable} from 'mobx';
import {observer} from 'mobx-react-lite';
import type {HTMLAttributes, ReactNode} from 'react';
import {useContext, useEffect, useState} from 'react';
import {RouteContext} from 'routra-react';
import {styled} from 'styled-components';

import {fadeInAnimationCSS, fadeOutAnimationCSS} from '../@animations.js';

import {ViewContext} from './@view-context.js';

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

  &.animation {
    &.entering {
      ${fadeInAnimationCSS}

      z-index: var(--view-entering-z-index);
    }

    &.leaving {
      ${fadeOutAnimationCSS}
    }
  }
`;

export const View = observer(
  ({
    animation = true,
    className,
    children,
    ...props
  }: HTMLAttributes<HTMLDivElement> & {
    animation?: boolean;
    children: ReactNode;
  }): ReactNode => {
    const {view, transition} = useContext(RouteContext);

    const [context] = useState(() =>
      observable({
        scrolled: false,
        canScrollDown: false,
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
        className={classNames(className, {
          animation,
          entering: view.$entering,
          leaving: view.$leaving,
        })}
        {...transition.events}
      >
        <ViewContext.Provider value={context}>{children}</ViewContext.Provider>
      </Container>
    );
  },
);
