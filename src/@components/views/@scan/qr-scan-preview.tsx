import {IonIcon} from '@ionic/react';
import check from 'lucide-static/icons/check.svg';
import {type ReactNode, useEffect, useRef} from 'react';
import {styled} from 'styled-components';

import {
  SCAN_REVEAL_DURATION,
  SCAN_REVEAL_EASING,
  animateScanFeedback,
} from '../../@ui/scan-motion.js';

export const SCAN_CIRCLE_INSET = 40;
export const SCAN_FRAME_OFFSET = 4;

const Aperture = styled.div`
  position: absolute;
  inset: 50%;
  border-radius: 50%;
  transform: translateY(${SCAN_FRAME_OFFSET}px);
  box-shadow: 0 0 0 100vmax var(--ion-color-primary-contrast);
  overflow: hidden;
  pointer-events: none;
`;

const Cover = styled.div`
  position: absolute;
  inset: 0;
  background: #f0f0f0;
  display: grid;
  place-items: center;
`;

const Confirmation = styled.div`
  display: grid;
  place-items: center;
  opacity: 0;

  ion-icon {
    font-size: 28px;
    color: var(--ion-color-primary);
  }
`;

export type QrScanPreviewPhase =
  | 'starting'
  | 'scanning'
  | 'completing'
  | 'scanned'
  | 'idle';

type MotionStyles = Partial<
  Pick<CSSStyleDeclaration, 'inset' | 'borderRadius' | 'opacity' | 'transform'>
>;

const CIRCLE = {
  inset: `${SCAN_CIRCLE_INSET}%`,
  borderRadius: '50%',
  transform: `translateY(${SCAN_FRAME_OFFSET}px)`,
};
const FRAME = {
  inset: '0%',
  borderRadius: `${(20 / 430) * 100}%`,
  transform: 'translateY(0px)',
};

const BREATH_DURATION = 2080;
const BREATH_PEAK_OFFSET = 416 / BREATH_DURATION;
const BREATH_RETURN_OFFSET = 1480 / BREATH_DURATION;
const BREATH_PEAK_HANDLE = 0.24;
// Equal control-handle durations keep acceleration continuous at the peak.
const BREATH_RETURN_START_HANDLE =
  (BREATH_PEAK_HANDLE * BREATH_PEAK_OFFSET) /
  (BREATH_RETURN_OFFSET - BREATH_PEAK_OFFSET);
const BREATH_RETURN_END_HANDLE = 0.4;

export function QrScanPreview({
  phase,
  onCovered,
  onSettled,
}: {
  phase: QrScanPreviewPhase;
  onCovered: () => void;
  onSettled: (phase: QrScanPreviewPhase | undefined) => void;
}): ReactNode {
  const apertureRef = useRef<HTMLDivElement>(null);
  const coverRef = useRef<HTMLDivElement>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef({onCovered, onSettled});

  useEffect(() => {
    callbacksRef.current = {onCovered, onSettled};
  }, [onCovered, onSettled]);

  useEffect(() => {
    const aperture = apertureRef.current!;
    const cover = coverRef.current!;
    const confirmation = confirmationRef.current!;
    const elements = [aperture, cover, confirmation];
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false;

    const move = async (
      element: HTMLElement,
      target: MotionStyles,
      duration: number,
    ): Promise<void> => {
      const style = getComputedStyle(element);
      const from = Object.fromEntries(
        Object.keys(target).map(property => [
          property,
          style[property as keyof MotionStyles],
        ]),
      );
      const animation = element.animate([from, target], {
        duration: reducedMotion.matches ? 0 : duration,
        easing: SCAN_REVEAL_EASING,
        fill: 'forwards',
      });

      await animation.finished;
      if (disposed) return;

      Object.assign(element.style, target);
      animation.cancel();
    };

    callbacksRef.current.onSettled(undefined);

    void (async () => {
      if (phase === 'starting') {
        await Promise.all([
          move(cover, {opacity: '1'}, 160),
          move(confirmation, {opacity: '0'}, 160),
          move(aperture, CIRCLE, 280),
        ]);
        if (disposed || reducedMotion.matches) return;

        aperture.animate(
          [
            {
              ...CIRCLE,
              offset: 0,
              easing: `cubic-bezier(0.68, 0, ${1 - BREATH_PEAK_HANDLE}, 1)`,
            },
            {
              ...CIRCLE,
              inset: '38%',
              offset: BREATH_PEAK_OFFSET,
              easing: `cubic-bezier(${BREATH_RETURN_START_HANDLE}, 0, ${BREATH_RETURN_END_HANDLE}, 1)`,
            },
            {...CIRCLE, offset: BREATH_RETURN_OFFSET},
            {...CIRCLE, offset: 1},
          ],
          {duration: BREATH_DURATION, iterations: Infinity},
        );
      } else if (phase === 'scanning') {
        await Promise.all([
          move(aperture, FRAME, SCAN_REVEAL_DURATION),
          move(cover, {opacity: '0'}, SCAN_REVEAL_DURATION),
        ]);
        if (!disposed) callbacksRef.current.onSettled(phase);
      } else if (phase === 'completing') {
        await move(cover, {opacity: '1'}, 240);
        if (!disposed) callbacksRef.current.onCovered();
      } else if (phase === 'scanned') {
        await Promise.all([
          move(aperture, CIRCLE, SCAN_REVEAL_DURATION),
          move(confirmation, {opacity: '1'}, 240),
        ]);
        if (disposed) return;

        if (!reducedMotion.matches) animateScanFeedback(confirmation);
        callbacksRef.current.onSettled(phase);
      } else {
        // Keep the mask opaque while the opening closes, including camera errors.
        await Promise.all([
          move(cover, {opacity: '1'}, 160),
          move(confirmation, {opacity: '0'}, 160),
        ]);
        if (disposed) return;

        await move(aperture, {...CIRCLE, inset: '50%'}, 280);
        if (!disposed) callbacksRef.current.onSettled(phase);
      }
    })().catch(error => {
      if (!disposed) throw error;
    });

    const onMotionChange = (): void => {
      if (!reducedMotion.matches) return;

      for (const element of elements) {
        for (const animation of element.getAnimations()) {
          if (animation.effect?.getTiming().iterations === Infinity) {
            animation.cancel();
          } else {
            animation.finish();
          }
        }
      }
    };

    reducedMotion.addEventListener('change', onMotionChange);

    return () => {
      disposed = true;
      for (const element of elements) {
        const {inset, borderRadius, opacity, transform} =
          getComputedStyle(element);
        Object.assign(element.style, {inset, borderRadius, opacity, transform});
        for (const animation of element.getAnimations()) animation.cancel();
      }
      reducedMotion.removeEventListener('change', onMotionChange);
    };
  }, [phase]);

  return (
    <Aperture ref={apertureRef} aria-hidden="true">
      <Cover ref={coverRef}>
        <Confirmation ref={confirmationRef}>
          <IonIcon icon={check} />
        </Confirmation>
      </Cover>
    </Aperture>
  );
}
