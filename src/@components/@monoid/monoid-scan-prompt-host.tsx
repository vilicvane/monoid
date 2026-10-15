import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import type {MonoidScanPromptPresentation} from '../../@services/index.js';
import {playScanSound} from '../@ui/scan-sound.js';

import {MonoidScanCard} from './monoid-scan-card.js';

const Container = styled.div<{$closing: boolean}>`
  box-sizing: border-box;
  position: fixed;
  z-index: calc(var(--popup-z-index) + 1);
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  padding: calc(var(--view-inset-top) + 16px)
    calc(var(--view-inset-right) + 16px) calc(var(--view-inset-bottom) + 16px)
    calc(var(--view-inset-left) + 16px);
  overflow: hidden;
  pointer-events: ${props => (props.$closing ? 'none' : 'auto')};

  display: flex;
  align-items: flex-start;
  justify-content: center;
`;

const PromptContainer = styled.div`
  width: 100%;
  max-width: 420px;

  display: flex;
  flex-direction: column;
  gap: 16px;
`;

const PromptStateContent = styled.div`
  position: relative;
  min-height: 50px;
  line-height: 25px;
  text-align: center;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.8);
`;

export const MonoidScanPromptHost = observer((): ReactNode => {
  const {monoidScanPromptPresenter, portals} = useEntrances();
  const {current} = monoidScanPromptPresenter;

  return createPortal(
    current && <MonoidScanPromptLayer presentation={current} />,
    portals.popup,
  );
});

function MonoidScanPromptLayer({
  presentation,
}: {
  presentation: MonoidScanPromptPresentation;
}): ReactNode {
  const {
    monoidScanPromptPresenter,
    errorService,
    portals: {popupBackdrop},
  } = useEntrances();
  const containerRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const stateContentRef = useRef<HTMLDivElement>(null);
  const presentationRef = useRef(presentation);
  const initializedRef = useRef(false);
  const [arrived, setArrived] = useState(false);
  const [backdropOwner] = useState(() => Symbol());
  const {closing, scanning, token} = presentation;

  useLayoutEffect(() => {
    if (scanning && !closing) {
      return playScanSound();
    }

    return undefined;
  }, [scanning, closing, token]);

  useLayoutEffect(() => {
    presentationRef.current = presentation;
  }, [presentation]);

  useLayoutEffect(() => {
    const shown = presentationRef.current;

    return () => {
      monoidScanPromptPresenter.remove(shown, false);
      errorService.catch(popupBackdrop.release(backdropOwner));
    };
  }, [
    token,
    monoidScanPromptPresenter,
    popupBackdrop,
    backdropOwner,
    errorService,
  ]);

  useLayoutEffect(() => {
    const container = containerRef.current!;
    const prompt = promptRef.current!;
    const card = cardRef.current!;
    const stateContent = stateContentRef.current!;
    const canvas = card.querySelector('canvas')!;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const shown = presentationRef.current;

    if (!initializedRef.current) {
      const rect = card.getBoundingClientRect();
      const offset = container.clientHeight / 2 - rect.top - rect.height / 2;

      card.style.transform = `translateY(${offset}px) perspective(2400px) rotateX(-90deg) scale(0.88)`;
      canvas.style.opacity = '0';
      stateContent.style.opacity = '0';
      initializedRef.current = true;
    }

    const animations: Animation[] = [];
    let cancelled = false;

    const onMotionChange = (): void => {
      if (reducedMotion.matches) {
        for (const animation of animations) {
          animation.finish();
        }
      }
    };

    reducedMotion.addEventListener('change', onMotionChange);

    errorService.catch(
      (async () => {
        try {
          if (reducedMotion.matches) {
            if (closing) {
              await popupBackdrop.release(backdropOwner);

              if (!cancelled) {
                monoidScanPromptPresenter.remove(shown, true);
              }
            } else {
              await popupBackdrop.acquire(backdropOwner);

              if (!cancelled) {
                card.style.transform = 'none';
                prompt.style.transform = 'none';
                canvas.style.opacity = '1';
                stateContent.style.opacity = '1';
                setArrived(true);
              }
            }

            return;
          }

          if (!closing) {
            setArrived(false);

            await popupBackdrop.acquire(backdropOwner);

            if (cancelled) {
              return;
            }

            const arrival = card.animate(
              [
                {transform: getComputedStyle(card).transform},
                {
                  transform:
                    'translateY(0) perspective(2400px) rotateX(0deg) scale(1)',
                },
              ],
              {
                duration: reducedMotion.matches ? 0 : 480,
                easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                fill: 'forwards',
              },
            );

            animations.push(
              arrival,
              prompt.animate([{}, {transform: 'translateY(0)'}], {
                duration: reducedMotion.matches ? 0 : 480,
                easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                fill: 'forwards',
              }),
            );
            await arrival.finished;

            if (cancelled) {
              return;
            }

            setArrived(true);
          }

          const fadeAnimations = [canvas, stateContent].map(element =>
            element.animate([{}, {opacity: closing ? 0 : 1}], {
              duration: reducedMotion.matches ? 0 : closing ? 120 : 160,
              easing: 'ease-out',
              fill: 'forwards',
            }),
          );

          animations.push(...fadeAnimations);
          await Promise.all(
            fadeAnimations.map(animation => animation.finished),
          );

          if (cancelled || !closing) {
            return;
          }

          const offset = new DOMMatrixReadOnly(
            getComputedStyle(prompt).transform,
          ).m42;
          const bottom = Math.max(
            prompt.getBoundingClientRect().bottom,
            card.getBoundingClientRect().bottom,
          );
          const cardAnimation = prompt.animate(
            [{}, {transform: `translateY(${offset - bottom}px)`}],
            {
              duration: reducedMotion.matches ? 0 : 180,
              easing: 'ease-in',
              fill: 'forwards',
            },
          );

          animations.push(cardAnimation);
          await cardAnimation.finished;

          if (cancelled) {
            return;
          }

          await popupBackdrop.release(backdropOwner);

          if (!cancelled) {
            monoidScanPromptPresenter.remove(shown, true);
          }
        } catch (error) {
          if (!cancelled) {
            monoidScanPromptPresenter.remove(shown, false);

            throw error;
          }
        }
      })(),
    );

    return () => {
      cancelled = true;
      reducedMotion.removeEventListener('change', onMotionChange);

      for (const animation of animations) {
        animation.commitStyles();
        animation.cancel();
      }
    };
  }, [
    closing,
    token,
    monoidScanPromptPresenter,
    errorService,
    popupBackdrop,
    backdropOwner,
  ]);

  return (
    <Container
      ref={containerRef}
      $closing={presentation.closing}
      aria-hidden={presentation.closing}
      inert={presentation.closing}
      onClick={presentation.onDismiss}
    >
      <PromptContainer ref={promptRef}>
        <div ref={cardRef}>
          <MonoidScanCard
            scanning={presentation.scanning}
            wavesActive={arrived && !closing}
          />
        </div>
        <PromptStateContent ref={stateContentRef}>
          {presentation.content}
        </PromptStateContent>
      </PromptContainer>
    </Container>
  );
}
