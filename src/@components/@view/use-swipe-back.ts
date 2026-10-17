import {createGesture} from '@ionic/react';
import type {RefObject, TransitionEvent} from 'react';
import {useEffect, useRef} from 'react';
import type {RouteSwitching, ViewEntry__} from 'routra';

import {useEntrances} from '../../@entrances.js';
import type {ViewSwitchingState} from '../../@routes.js';

export function useSwipeBack(
  view: ViewEntry__,
  enabled: boolean,
): {
  ref: RefObject<HTMLDivElement | null>;
  onTransitionEnd(event: TransitionEvent<HTMLDivElement>): void;
} {
  const {router} = useEntrances();
  const ref = useRef<HTMLDivElement>(null);
  const swipe = useRef<{
    switching: RouteSwitching<ViewSwitchingState>;
    progress: number;
    complete?: boolean;
  }>(undefined);
  const leaving = !!view.$leaving;

  useEffect(() => {
    if (!enabled || leaving) return;

    const element = ref.current!;
    let suppressClick = false;
    let settleFrame = 0;
    const update = (deltaX: number): void => {
      const progress = Math.max(0, Math.min(1, deltaX / element.clientWidth));

      if (swipe.current) {
        swipe.current.progress = progress;
        swipe.current.switching({progress});
      } else if (progress > 0) {
        swipe.current = {
          switching: router.$back.$switch({progress}),
          progress,
        };
        suppressClick = true;
      }
    };

    const gesture = createGesture({
      el: element,
      gestureName: 'view-swipe-back',
      direction: 'x',
      threshold: 10,
      disableScroll: true,
      canStart: ({event}) => {
        suppressClick = false;

        return (
          router.$ableToBack &&
          view.$match.$exact.$active &&
          !view.$entering &&
          !view.$leaving &&
          !view.$switching &&
          !document.activeElement?.matches(
            'input, textarea, [contenteditable="true"]',
          ) &&
          !(event.target as Element).closest(
            'button, a, input, textarea, select, [contenteditable="true"]',
          )
        );
      },
      onMove: ({deltaX}) => update(deltaX),
      onEnd: ({deltaX, velocityX, event}) => {
        update(deltaX);
        const current = swipe.current;
        if (!current) return;

        const complete =
          event.type !== 'touchcancel' &&
          ((current.progress > 0.25 && velocityX >= 0) || velocityX > 0.5);

        if (current.progress === Number(complete)) {
          swipe.current = undefined;
          if (complete) current.switching.$complete();
          else current.switching.$abort();
        } else {
          current.complete = complete;
          settleFrame = requestAnimationFrame(() => {
            // Establish the dragged position even when the gesture ends before paint.
            element.getBoundingClientRect();
            current.switching({progress: Number(complete), settling: true});
          });
        }
      },
    });

    const onClick = (event: MouseEvent): void => {
      if (suppressClick) {
        event.preventDefault();
        event.stopPropagation();
        suppressClick = false;
      }
    };

    gesture.enable();
    element.addEventListener('click', onClick, true);

    return () => {
      gesture.destroy();
      cancelAnimationFrame(settleFrame);
      element.removeEventListener('click', onClick, true);
      swipe.current?.switching.$abort();
      swipe.current = undefined;
    };
  }, [enabled, leaving, router, view]);

  return {
    ref,
    onTransitionEnd(event) {
      const current = swipe.current;
      if (
        event.target !== event.currentTarget ||
        event.propertyName !== 'transform' ||
        current?.complete === undefined
      ) {
        return;
      }

      swipe.current = undefined;
      if (current.complete) current.switching.$complete();
      else current.switching.$abort();
    },
  };
}
