import {type RefObject, useLayoutEffect, useRef} from 'react';

export function useAnimationHint<T extends HTMLElement>(
  motionState: unknown,
): RefObject<T | null> {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    let cancelled = false;
    element.style.willChange = 'transform, opacity';

    // Include delayed transitions and release the hint on completion or cancellation.
    void Promise.allSettled(
      element.getAnimations().map(animation => animation.finished),
    ).then(() => {
      if (!cancelled) element.style.removeProperty('will-change');
    });

    return () => {
      cancelled = true;
      element.style.removeProperty('will-change');
    };
  }, [motionState]);

  return ref;
}
