import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {useLayoutEffect, useRef} from 'react';
import {createPortal} from 'react-dom';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import type {MonoidScanPromptPresentation} from '../../@services/index.js';

import {MonoidScanCard} from './monoid-scan-card.js';

const Backdrop = styled.div<{$closing: boolean}>`
  box-sizing: border-box;
  position: fixed;
  z-index: var(--popup-z-index);
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  padding: calc(var(--view-inset-top) + 16px)
    calc(var(--view-inset-right) + 16px) calc(var(--view-inset-bottom) + 16px)
    calc(var(--view-inset-left) + 16px);
  background-color: rgba(0, 0, 0, 0.5);
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
  const {monoidScanPromptPresenter, errorService} = useEntrances();
  const backdropRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  const stateContentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!presentation.closing) {
      return;
    }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    if (reducedMotion.matches) {
      monoidScanPromptPresenter.remove(presentation);

      return;
    }

    const animations: Animation[] = [];
    let cancelled = false;

    const onMotionChange = (): void => {
      if (reducedMotion.matches) {
        monoidScanPromptPresenter.remove(presentation);
      }
    };

    reducedMotion.addEventListener('change', onMotionChange);

    errorService.catch(
      (async () => {
        try {
          const fadeAnimations = [
            promptRef.current!.querySelector('canvas')!,
            stateContentRef.current!,
          ].map(element =>
            element.animate([{opacity: 1}, {opacity: 0}], {
              duration: 120,
              easing: 'ease-out',
              fill: 'forwards',
            }),
          );

          animations.push(...fadeAnimations);
          await Promise.all(
            fadeAnimations.map(animation => animation.finished),
          );

          if (cancelled) {
            return;
          }

          const cardAnimation = promptRef.current!.animate(
            [
              {transform: 'translateY(0)'},
              {
                transform: `translateY(-${promptRef.current!.getBoundingClientRect().bottom}px)`,
              },
            ],
            {duration: 180, easing: 'ease-in', fill: 'forwards'},
          );

          animations.push(cardAnimation);
          await cardAnimation.finished;

          if (cancelled) {
            return;
          }

          const backdropAnimation = backdropRef.current!.animate(
            [
              {backgroundColor: 'rgba(0, 0, 0, 0.5)'},
              {backgroundColor: 'rgba(0, 0, 0, 0)'},
            ],
            {duration: 180, easing: 'ease-in', fill: 'forwards'},
          );

          animations.push(backdropAnimation);
          await backdropAnimation.finished;

          if (!cancelled) {
            monoidScanPromptPresenter.remove(presentation);
          }
        } catch (error) {
          if (!cancelled) {
            monoidScanPromptPresenter.remove(presentation);

            throw error;
          }
        }
      })(),
    );

    return () => {
      cancelled = true;
      reducedMotion.removeEventListener('change', onMotionChange);

      for (const animation of animations) {
        animation.cancel();
      }
    };
  }, [presentation, monoidScanPromptPresenter, errorService]);

  return (
    <Backdrop
      ref={backdropRef}
      $closing={presentation.closing}
      aria-hidden={presentation.closing}
      inert={presentation.closing}
      onClick={presentation.onDismiss}
    >
      <PromptContainer ref={promptRef}>
        <MonoidScanCard
          scanning={presentation.scanning}
          wavesActive={!presentation.closing}
        />
        <PromptStateContent ref={stateContentRef}>
          {presentation.content}
        </PromptStateContent>
      </PromptContainer>
    </Backdrop>
  );
}
