import {createGesture} from '@ionic/react';
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {css, styled} from 'styled-components';

import './swipeable-item.css';

const ACTION_WIDTH = 54;
const ACTIONS_PADDING = 9;

const Container = styled.div<{$dragging: boolean}>`
  position: relative;
  overflow: hidden;
  transition: ${({$dragging}) =>
    $dragging ? 'none' : '--swipe-progress 180ms ease-out'};

  &:focus-visible {
    outline: 2px solid var(--ion-color-primary);
    outline-offset: -2px;
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

const Actions = styled.div<{$count: number}>`
  position: absolute;
  inset: 0 0 0 auto;
  padding: 0 ${ACTIONS_PADDING}px;

  display: flex;

  > * {
    transform: scale(0);
    transform-origin: center calc(50% + 4px);
  }

  ${({$count}) =>
    Array.from(
      {length: $count},
      (_, index) => css`
        > :nth-last-child(${index + 1}) {
          transform: scale(
            clamp(
              0,
              calc(
                (
                    var(--swipe-progress) * var(--swipe-width) -
                      ${ACTIONS_PADDING + index * ACTION_WIDTH}
                  ) /
                  ${ACTION_WIDTH}
              ),
              1
            )
          );
        }
      `,
    )}

  @media (prefers-reduced-motion: reduce) {
    > :nth-child(n) {
      transform: none;
    }
  }
`;

export const SwipeAction = styled.button<{$color?: string}>`
  --swipe-action-color: ${({$color = 'var(--ion-color-primary)'}) => $color};

  width: ${ACTION_WIDTH}px;
  flex-shrink: 0;
  padding: 12px 0 4px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 11px;
  line-height: 14px;
  white-space: nowrap;

  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;

  ion-icon {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    padding: 9px;
    border-radius: 50%;
    background: var(--swipe-action-color);
    color: var(--ion-color-primary-contrast);
  }

  &:focus-visible {
    outline: 2px solid var(--swipe-action-color);
    outline-offset: -4px;
  }
`;

const Content = styled.div`
  position: relative;
  overflow: hidden;
  transform: translate3d(
    calc(var(--swipe-progress) * var(--swipe-width) * -1px),
    0,
    0
  );
  background-color: color-mix(
    in srgb,
    var(--ion-color-primary-contrast),
    var(--ion-color-dark) calc(var(--swipe-progress) * 5%)
  );
  border-radius: calc(var(--swipe-progress) * 8px);
  touch-action: pan-y;
  user-select: none;
`;

export const SwipeableItem = ({
  open,
  onOpenChange,
  actions,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: ReactNode;
  children: ReactNode;
}): ReactNode => {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  const suppressClickRef = useRef(false);
  const actionsId = useId();
  const [actionsWidth, setActionsWidth] = useState(0);
  const [actionCount, setActionCount] = useState(0);
  const [dragOffset, setDragOffset] = useState<number>();
  const offset = dragOffset ?? (open ? -actionsWidth : 0);
  const progress = actionsWidth ? Math.min(1, -offset / actionsWidth) : 0;

  useLayoutEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  useLayoutEffect(() => {
    if (!open && actionsRef.current!.contains(document.activeElement)) {
      containerRef.current!.focus({preventScroll: true});
    }
  }, [open]);

  useLayoutEffect(() => {
    const actions = actionsRef.current!;
    const updateLayout = (): void => {
      setActionsWidth(actions.offsetWidth);
      setActionCount(actions.childElementCount);
    };
    const observer = new ResizeObserver(updateLayout);

    updateLayout();
    observer.observe(actions);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let initialOffset = 0;
    const clamp = (offset: number): number =>
      Math.max(-actionsWidth, Math.min(0, offset));

    const gesture = createGesture({
      el: contentRef.current!,
      gestureName: 'swipeable-item',
      direction: 'x',
      threshold: 10,
      canStart: ({event}) =>
        !(event.target as Element).closest(
          'button, a, input, textarea, select',
        ),
      onStart: () => {
        initialOffset =
          -parseFloat(
            getComputedStyle(containerRef.current!).getPropertyValue(
              '--swipe-progress',
            ),
          ) * actionsWidth;
        suppressClickRef.current = true;
        setDragOffset(initialOffset);
      },
      onMove: ({deltaX}) => setDragOffset(clamp(initialOffset + deltaX)),
      onEnd: ({deltaX, velocityX, event}) => {
        const offset = clamp(initialOffset + deltaX);
        const nextOpen =
          event.type === 'touchcancel'
            ? open
            : Math.abs(velocityX) > 0.2
              ? velocityX < 0
              : offset < -actionsWidth / 2;

        setDragOffset(undefined);
        onOpenChangeRef.current(nextOpen);
      },
    });

    gesture.enable();

    return () => gesture.destroy();
  }, [actionsWidth, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (!containerRef.current!.contains(event.target as Node)) {
        onOpenChangeRef.current(false);
      }
    };

    document.addEventListener('pointerdown', onPointerDown);

    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <Container
      ref={containerRef}
      $dragging={dragOffset !== undefined}
      style={
        {
          '--swipe-progress': progress,
          '--swipe-width': actionsWidth,
        } as CSSProperties
      }
      role="group"
      tabIndex={0}
      aria-label="Item actions"
      aria-controls={actionsId}
      aria-keyshortcuts="ArrowLeft ArrowRight Escape"
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          onOpenChange(false);
          containerRef.current?.focus();
        } else if (
          event.target === event.currentTarget &&
          (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
        ) {
          event.preventDefault();
          onOpenChange(event.key === 'ArrowLeft');
        }
      }}
    >
      <Actions
        ref={actionsRef}
        $count={actionCount}
        id={actionsId}
        aria-hidden={!open}
        inert={!open}
      >
        {actions}
      </Actions>
      <Content
        ref={contentRef}
        onPointerDownCapture={() => {
          suppressClickRef.current = false;
        }}
        onClickCapture={event => {
          if (suppressClickRef.current) {
            event.preventDefault();
            event.stopPropagation();
            suppressClickRef.current = false;
          }
        }}
      >
        {children}
      </Content>
    </Container>
  );
};
