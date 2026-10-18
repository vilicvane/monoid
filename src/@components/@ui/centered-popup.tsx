import type {BackButtonEvent} from '@ionic/react';
import {
  Fragment,
  type ReactNode,
  type SyntheticEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {createPortal} from 'react-dom';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {popupContentAnimation} from '../@animations.js';

import {PopupBackdrop} from './popup-backdrop.js';

const Layer = styled.div`
  box-sizing: border-box;
  position: absolute;
  inset: 0;
  z-index: calc(var(--popup-z-index) + 1);
  padding: calc(var(--view-inset-top) + 24px)
    calc(var(--view-inset-right) + 24px) calc(var(--view-inset-bottom) + 24px)
    calc(var(--view-inset-left) + 24px);
  overflow-y: auto;
  overscroll-behavior: contain;
  pointer-events: auto;

  display: flex;
  flex-direction: column;
  align-items: center;
`;

const Dialog = styled.div`
  --color-text-label: rgba(255, 255, 255, 0.7);
  --color-text-secondary: white;
  --color-message-background: rgba(255, 255, 255, 0.12);
  --color-segmented-border: rgba(255, 255, 255, 0.45);
  --color-address-tag-background: rgba(255, 255, 255, 0.08);
  --color-address-tag-border: rgba(255, 255, 255, 0.55);
  --color-address-tag-text: white;
  --color-address-primary: white;
  --color-address-safe: color-mix(in srgb, var(--ion-color-safe) 45%, white);
  --color-address-warning: color-mix(
    in srgb,
    var(--ion-color-warning) 70%,
    white
  );
  --color-address-danger: color-mix(
    in srgb,
    var(--ion-color-danger) 35%,
    white
  );
  --color-address-seen: rgba(255, 255, 255, 0.65);

  box-sizing: border-box;
  width: 100%;
  max-width: 320px;
  min-width: 0;
  flex-shrink: 0;
  margin: auto 0;
  /* Leave room for the items to rise without clipping at the scroll edge. */
  padding: 14px 2px;
  color: white;
  outline: none;
  pointer-events: auto;

  display: flex;
  flex-direction: column;
  gap: 16px;
`;

function getTabStops(dialog: HTMLElement): HTMLElement[] {
  const candidates = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [tabindex]',
    ),
  ).filter(
    element =>
      element.tabIndex >= 0 &&
      !element.matches(':disabled') &&
      !element.closest('[inert]') &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden',
  );

  return candidates.filter(element => {
    if (
      !(element instanceof HTMLInputElement) ||
      element.type !== 'radio' ||
      !element.name
    ) {
      return true;
    }

    const group = candidates.filter(
      candidate =>
        candidate instanceof HTMLInputElement &&
        candidate.type === 'radio' &&
        candidate.name === element.name &&
        candidate.form === element.form,
    ) as HTMLInputElement[];

    return element === (group.find(radio => radio.checked) ?? group[0]);
  });
}

function focusContent(
  dialog: HTMLElement,
  initialFocus: 'control' | 'dialog',
  focusIndex = -1,
): void {
  const stops = getTabStops(dialog);
  const target =
    stops[focusIndex] ??
    (initialFocus === 'dialog'
      ? dialog
      : (stops.find(element =>
          element.matches('input[type="radio"]:checked'),
        ) ??
        stops.find(element => element.matches('button')) ??
        stops[0] ??
        dialog));

  target.focus({preventScroll: true});
}

function preventInteraction(event: SyntheticEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

export const CenteredPopup = ({
  className,
  children,
  contentKey,
  onDismiss,
  initialFocus = 'control',
  'aria-label': ariaLabel,
}: {
  className?: string;
  children: ReactNode;
  contentKey?: string;
  onDismiss: () => void;
  initialFocus?: 'control' | 'dialog';
  'aria-label': string;
}): ReactNode => {
  const {
    portals: {popup},
  } = useEntrances();
  const layerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  const [trigger] = useState(() => document.activeElement);
  const [displayedKey, setDisplayedKey] = useState(contentKey);
  const motionKeyRef = useRef(displayedKey);
  const changing = contentKey !== displayedKey;
  const changingRef = useRef(changing);
  const entryAnimations = useRef<Animation[]>([]);
  const contentRef = useRef({children, ariaLabel, initialFocus});
  const positions = useRef(
    new Map<string | undefined, {scrollTop: number; focusIndex: number}>(),
  );
  const content = changing
    ? contentRef.current
    : {children, ariaLabel, initialFocus};

  useLayoutEffect(() => {
    dismissRef.current = onDismiss;
    contentRef.current = content;
    changingRef.current = changing;
  });

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const resetMotion = (): void => {
      dialog.style.opacity = '';
      dialog.style.transform = '';
    };
    if (motionKeyRef.current !== displayedKey) {
      motionKeyRef.current = displayedKey;
      resetMotion();
    }

    const exiting = contentKey !== displayedKey;
    for (const animation of entryAnimations.current) {
      if (exiting && animation.playState === 'running') animation.pause();
      if (!exiting && animation.playState === 'paused') animation.play();
    }
    const position = positions.current.get(displayedKey);
    if (!exiting) {
      if (position && document.activeElement === dialog) {
        focusContent(
          dialog,
          contentRef.current.initialFocus,
          position.focusIndex,
        );
      }
      if (!dialog.style.opacity && !dialog.style.transform) return;
    } else {
      const focusIndex = getTabStops(dialog).indexOf(
        document.activeElement as HTMLElement,
      );
      positions.current.set(displayedKey, {
        scrollTop: layerRef.current!.scrollTop,
        focusIndex: focusIndex >= 0 ? focusIndex : (position?.focusIndex ?? -1),
      });
      dialog.focus({preventScroll: true});
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      resetMotion();
      if (exiting) setDisplayedKey(contentKey);
      return;
    }

    const {enter, exit} = popupContentAnimation;
    const current = getComputedStyle(dialog);
    const animation = dialog.animate(
      [
        {opacity: current.opacity, transform: current.transform},
        {
          opacity: exiting ? 0 : 1,
          transform: `translateY(${exiting ? exit.offset : 0}px)`,
        },
      ],
      {
        duration: exit.duration,
        easing: exiting ? exit.easing : enter.easing,
        fill: 'forwards',
      },
    );
    let active = true;
    void animation.finished.then(
      () => {
        if (!active) return;
        if (exiting) {
          setDisplayedKey(contentKey);
        } else {
          resetMotion();
          animation.cancel();
        }
      },
      () => undefined,
    );

    return () => {
      active = false;
      if (animation.playState !== 'idle') {
        const current = getComputedStyle(dialog);
        dialog.style.opacity = current.opacity;
        dialog.style.transform = current.transform;
      }
      animation.cancel();
    };
  }, [contentKey, displayedKey]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const position = positions.current.get(displayedKey);
    focusContent(dialog, contentRef.current.initialFocus, position?.focusIndex);
    layerRef.current!.scrollTop = position?.scrollTop ?? 0;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const {enter} = popupContentAnimation;
    const items = Array.from(dialog.children).flatMap(item =>
      item.hasAttribute('data-popup-animation-group')
        ? Array.from(item.children, element => ({element, grouped: true}))
        : [{element: item, grouped: false}],
    );
    const grouped = items.some(item => item.grouped);
    const viewport = layerRef.current!.getBoundingClientRect();
    let index = 0;
    const animations = items
      .filter(({element}) => {
        if (!grouped) return true;
        const bounds = element.getBoundingClientRect();
        return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
      })
      .map(({element, grouped}) => {
        const animation = element.animate(
          [
            {opacity: 0, transform: `translateY(${enter.offset}px)`},
            {
              opacity: getComputedStyle(element).opacity,
              transform: 'translateY(0)',
            },
          ],
          {
            duration: enter.duration,
            delay: index * enter.stagger,
            easing: enter.easing,
            fill: 'backwards',
          },
        );
        // A list divider enters together with the following item.
        if (!grouped || element.tagName !== 'HR') index++;
        return animation;
      });
    entryAnimations.current = animations;

    return () => {
      for (const animation of animations) animation.cancel();
      entryAnimations.current = [];
    };
  }, [displayedKey]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const focusInitial = (): void => {
      focusContent(
        dialog,
        changingRef.current ? 'dialog' : contentRef.current.initialFocus,
      );
    };

    const onFocusIn = (event: FocusEvent): void => {
      if (!dialog.contains(event.target as Node)) {
        focusInitial();
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) {
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismissRef.current();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }
      if (changingRef.current) {
        event.preventDefault();
        return;
      }

      const stops = getTabStops(dialog);
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;

      if (!first) {
        event.preventDefault();
        dialog.focus();
      } else if (active === dialog || !dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const onBackButton = (event: Event): void => {
      (event as BackButtonEvent).detail.register(100, () => {
        dismissRef.current();
      });
    };

    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('ionBackButton', onBackButton);

    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('ionBackButton', onBackButton);

      if (trigger instanceof HTMLElement && trigger.isConnected) {
        trigger.focus({preventScroll: true});
      }
    };
  }, [trigger]);

  return (
    <>
      <PopupBackdrop onDismiss={onDismiss} />
      {createPortal(
        <Layer
          ref={layerRef}
          onClick={event => {
            event.stopPropagation();
            if (event.target === event.currentTarget) dismissRef.current();
          }}
        >
          <Dialog
            className={className}
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={content.ariaLabel}
            tabIndex={-1}
            onPointerDownCapture={changing ? preventInteraction : undefined}
            onClickCapture={changing ? preventInteraction : undefined}
            onKeyDownCapture={event => {
              if (changing && event.key !== 'Escape') preventInteraction(event);
            }}
          >
            <Fragment key={displayedKey}>{content.children}</Fragment>
          </Dialog>
        </Layer>,
        popup,
      )}
    </>
  );
};
