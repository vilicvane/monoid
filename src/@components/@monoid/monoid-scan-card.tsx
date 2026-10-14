import type {ReactNode} from 'react';
import {useEffect, useRef} from 'react';
import {styled} from 'styled-components';

import monoidCardWirelessInterface from '../../@assets/monoid-card-wireless-interface.svg';
import monoidLogo from '../../@assets/monoid.svg';
import {animateScanFeedback} from '../@ui/scan-motion.js';

import {MonoidCardWaves} from './monoid-card-waves.js';

const CardFrame = styled.div`
  position: relative;
  aspect-ratio: 430 / 270;
  border-radius: calc(20 / 430 * 100%) / calc(20 / 270 * 100%);
  background-color: var(--ion-color-dark-contrast);
`;

const CardWirelessInterface = styled.img`
  position: absolute;
  top: calc(43 / 270 * 100%);
  left: calc(40 / 430 * 100%);
  width: calc(32 / 430 * 100%);
`;

const CardLogo = styled.img`
  position: absolute;
  top: calc(170 / 270 * 100%);
  right: 0;
  width: calc(60 / 430 * 100%);
  background-color: var(--ion-color-primary);
`;

export function MonoidScanCard({
  scanning,
  wavesActive = true,
}: {
  scanning: boolean;
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
    <CardFrame ref={frameRef}>
      <MonoidCardWaves scanning={scanning} active={wavesActive} />
      <CardWirelessInterface src={monoidCardWirelessInterface} alt="" />
      <CardLogo src={monoidLogo} alt="" />
    </CardFrame>
  );
}
