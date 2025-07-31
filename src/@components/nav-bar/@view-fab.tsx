import {IonFab} from '@ionic/react';
import classNames from 'classNames';
import type {ReactNode} from 'react';
import {useEffect} from 'react';
import type {ViewEntry__} from 'routra';
import type {RouteViewComponentTransition} from 'routra-react';
import {styled} from 'styled-components';

import {popInAnimationCSS, popOutAnimationCSS} from '../@animations.js';

const Fab = styled(IonFab)`
  &.entering {
    ${popInAnimationCSS}
  }

  &.leaving {
    ${popOutAnimationCSS}

    pointer-events: none;
  }
`;

export const ViewFab = ({
  view,
  transition,
  children,
}: {
  view: ViewEntry__;
  transition: RouteViewComponentTransition;
  children: ReactNode;
}): ReactNode => {
  useEffect(
    () =>
      view.$transition({
        entering: true,
        leaving: true,
      }),
    [view],
  );

  return (
    <Fab
      className={classNames({
        entering: view.$entering,
        leaving: view.$leaving,
      })}
      vertical="top"
      horizontal="end"
      edge
      {...transition.events}
    >
      {children}
    </Fab>
  );
};
