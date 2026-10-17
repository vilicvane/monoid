import type {BackButtonEvent} from '@ionic/react';
import {type ReactNode, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';

import {PopupBackdrop} from './popup-backdrop.js';

const Layer = styled.div`
  box-sizing: border-box;
  position: absolute;
  inset: 0;
  z-index: calc(var(--popup-z-index) + 1);
  padding: calc(var(--view-inset-top) + 24px)
    calc(var(--view-inset-right) + 24px) calc(var(--view-inset-bottom) + 24px)
    calc(var(--view-inset-left) + 24px);
  pointer-events: none;

  display: flex;
  align-items: center;
  justify-content: center;
`;

const Dialog = styled.div`
  --color-text-label: rgba(255, 255, 255, 0.7);
  --color-text-secondary: white;
  --color-segmented-border: rgba(255, 255, 255, 0.45);
  --color-address-tag-background: rgba(255, 255, 255, 0.08);
  --color-address-tag-border: rgba(255, 255, 255, 0.55);
  --color-address-tag-text: white;

  box-sizing: border-box;
  width: 100%;
  max-width: 320px;
  max-height: 100%;
  min-width: 0;
  /* Leave room for the items to rise without clipping at the scroll edge. */
  padding: 14px 2px;
  color: white;
  outline: none;
  overflow-y: auto;
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

export const CenteredPopup = ({
  className,
  children,
  onDismiss,
  initialFocus = 'control',
  'aria-label': ariaLabel,
}: {
  className?: string;
  children: ReactNode;
  onDismiss: () => void;
  initialFocus?: 'control' | 'dialog';
  'aria-label': string;
}): ReactNode => {
  const {
    portals: {popup},
  } = useEntrances();
  const dialogRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  const [trigger] = useState(() => document.activeElement);

  useLayoutEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useLayoutEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const animations = Array.from(dialogRef.current!.children, (item, index) =>
      item.animate(
        [
          {opacity: 0, transform: 'translateY(12px)'},
          {
            opacity: getComputedStyle(item).opacity,
            transform: 'translateY(0)',
          },
        ],
        {
          duration: 260,
          delay: index * 55,
          easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
          fill: 'backwards',
        },
      ),
    );

    return () => {
      for (const animation of animations) animation.cancel();
    };
  }, []);

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const focusInitial = (): void => {
      const stops = getTabStops(dialog);
      const target =
        initialFocus === 'dialog'
          ? dialog
          : (stops.find(element =>
              element.matches('input[type="radio"]:checked'),
            ) ??
            stops.find(element => element.matches('button')) ??
            stops[0] ??
            dialog);

      target.focus({preventScroll: true});
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
    focusInitial();

    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('ionBackButton', onBackButton);

      if (trigger instanceof HTMLElement && trigger.isConnected) {
        trigger.focus({preventScroll: true});
      }
    };
  }, [trigger, initialFocus]);

  return (
    <>
      <PopupBackdrop onDismiss={onDismiss} />
      {createPortal(
        <Layer onClick={event => event.stopPropagation()}>
          <Dialog
            className={className}
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            tabIndex={-1}
          >
            {children}
          </Dialog>
        </Layer>,
        popup,
      )}
    </>
  );
};
