import type {ReactNode} from 'react';
import {useEffect, useRef} from 'react';

import {animateScanFeedback} from '../@ui/scan-motion.js';

import {MonoidCardWaves} from './monoid-card-waves.js';
import {MonoidCard} from './monoid-card.js';

export function MonoidScanCard({
  scanning,
  error = false,
  wavesActive = true,
}: {
  scanning: boolean;
  error?: boolean;
  wavesActive?: boolean;
}): ReactNode {
  const frameRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<Animation>(undefined);

  useEffect(() => {
    if (
      !scanning ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }

    animationRef.current?.cancel();
    animationRef.current = animateScanFeedback(frameRef.current!);
  }, [scanning]);

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    const onMotionChange = (): void => {
      if (reducedMotion.matches) {
        animationRef.current?.cancel();
      }
    };

    reducedMotion.addEventListener('change', onMotionChange);

    return () => {
      reducedMotion.removeEventListener('change', onMotionChange);
      animationRef.current?.cancel();
    };
  }, []);

  return (
    <MonoidCard ref={frameRef} error={error}>
      <MonoidCardWaves scanning={scanning} active={wavesActive} />
    </MonoidCard>
  );
}
