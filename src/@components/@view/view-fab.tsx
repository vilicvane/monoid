import {IonFab} from '@ionic/react';
import classNames from 'classNames';
import {observer} from 'mobx-react-lite';
import type {HTMLProps, ReactNode} from 'react';
import {useEffect} from 'react';
import {createPortal} from 'react-dom';
import type {ViewEntry__} from 'routra';
import type {RouteViewComponentTransition} from 'routra-react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {popInAnimationCSS, popOutAnimationCSS} from '../@animations.js';

const Fab = styled(IonFab)`
  bottom: calc(var(--nav-bar-height) + var(--view-inset-bottom) - 28px);
  z-index: 10;

  &.entering {
    ${popInAnimationCSS}
  }

  &.leaving {
    ${popOutAnimationCSS}

    pointer-events: none;
  }
`;

export const ViewFab = observer(
  ({
    view,
    transition,
    ...props
  }: {
    view: ViewEntry__;
    transition: RouteViewComponentTransition;
  } & HTMLProps<HTMLIonFabElement>): ReactNode => {
    const {portalsService} = useEntrances();

    useEffect(
      () =>
        view.$transition({
          entering: true,
          leaving: true,
        }),
      [view],
    );

    return createPortal(
      <Fab
        className={classNames({
          entering: view.$entering,
          leaving: view.$leaving,
        })}
        horizontal="end"
        {...transition.events}
        {...props}
      />,
      portalsService.fab,
    );
  },
);
