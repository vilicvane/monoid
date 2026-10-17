import {IonFab} from '@ionic/react';
import classNames from 'classNames';
import {observer} from 'mobx-react-lite';
import type {HTMLProps, ReactNode} from 'react';
import {useEffect, useImperativeHandle} from 'react';
import {createPortal} from 'react-dom';
import type {ViewEntry__} from 'routra';
import type {RouteViewComponentTransition} from 'routra-react';
import {styled} from 'styled-components';
import {UnmountAnimationClone} from 'unmount-animation-clone';

import {useEntrances} from '../../@entrances.js';
import {popInAnimationCSS, popOutAnimationCSS} from '../@animations.js';
import {useAnimationHint} from '../@hooks/use-animation-hint.js';

const Fab = styled(IonFab)`
  bottom: calc(100% - 28px);
  right: calc(10px + var(--ion-safe-area-right, 0px));
  z-index: var(--nav-bar-z-index);

  ${popInAnimationCSS}

  &.leaving {
    ${popOutAnimationCSS}

    pointer-events: none;
  }
`;

export const ViewFab = observer(
  ({
    view,
    transition,
    leaving = !!view.$leaving,
    ref: forwardedRef,
    ...props
  }: {
    view: ViewEntry__;
    transition: RouteViewComponentTransition;
    leaving?: boolean;
  } & HTMLProps<HTMLIonFabElement>): ReactNode => {
    const {portals} = useEntrances();
    const previewing = view.$switching?.$rel === 'to';
    const entering = view.$entering;
    const fabRef = useAnimationHint<HTMLIonFabElement>(
      previewing
        ? 'preview'
        : leaving
          ? 'leaving'
          : view.$entering
            ? 'entering'
            : 'active',
    );

    useImperativeHandle<HTMLIonFabElement | null, HTMLIonFabElement | null>(
      forwardedRef,
      () => (previewing ? null : fabRef.current),
      [fabRef, previewing],
    );

    useEffect(
      () =>
        view.$transition({
          entering: true,
          leaving: true,
        }),
      [view],
    );

    // A swipe preview must not add a FAB or reserve navigation space yet.
    if (previewing) return null;

    return createPortal(
      <UnmountAnimationClone
        onUnmountClone={clone => {
          if (clone.classList.contains('leaving')) {
            clone.remove();
            return;
          }

          clone.inert = true;
          clone.classList.add('leaving');
        }}
      >
        <Fab
          ref={fabRef}
          className={classNames({entering, leaving})}
          {...transition.events}
          {...props}
        />
      </UnmountAnimationClone>,
      portals.fab,
    );
  },
);
