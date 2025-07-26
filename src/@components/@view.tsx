import classNames from 'classnames';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {useContext, useEffect} from 'react';
import {RouteContext} from 'routra-react';
import {styled} from 'styled-components';

import {fadeInAnimationCSS, fadeOutAnimationCSS} from './@animations.js';

const Container = styled.div`
  padding-top: var(--view-inset-top);

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
        {children}
      </Container>
    );
  },
);
