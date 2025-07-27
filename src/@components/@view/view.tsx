import classNames from 'classNames';
import {observable} from 'mobx';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
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

  flex: 1;

  display: flex;
  flex-direction: column;

  &:not(.no-animation) {
    ${fadeInAnimationCSS}

    &.leaving {
      ${fadeOutAnimationCSS}
    }
  }
`;

export const View = observer(
  ({
    noAnimation = false,
    children,
  }: {
    noAnimation?: boolean;
    children: ReactNode;
  }): ReactNode => {
    const {view, transition} = useContext(RouteContext);

    const [context] = useState(() =>
      observable({
        scrolled: false,
      }),
    );

    useEffect(
      () =>
        view.$transition({
          leaving: !noAnimation,
        }),
      [noAnimation, view],
    );

    if (view.$entering) {
      return null;
    }

    return (
      <Container
        className={classNames({
          'no-animation': noAnimation,
          leaving: view.$leaving,
        })}
        {...transition.events}
      >
        <ViewContext.Provider value={context}>{children}</ViewContext.Provider>
      </Container>
    );
  },
);
