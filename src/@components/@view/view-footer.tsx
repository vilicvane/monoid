import {
  type ComponentProps,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';
import {keyframes, styled} from 'styled-components';
import {UnmountAnimationClone} from 'unmount-animation-clone';

import {popInAnimation, popOutAnimationCSS} from '../@animations.js';
import {Button, Buttons} from '../@ui/button.js';

const ACTION_EXIT_STAGGER = 100;

const actionExitKeyframes = keyframes`
  from {
    transform: translateY(0) scale(1);
    opacity: 1;
  }

  to {
    transform: translateY(16px) scale(0);
    opacity: 0;
  }
`;

const ActionButton = styled(Button)`
  transform-origin: center bottom;

  &.unmount {
    ${popOutAnimationCSS}
    animation-name: ${actionExitKeyframes};
    animation-delay: var(--footer-action-exit-delay, 0ms);
    animation-fill-mode: both;
    pointer-events: none;
  }

  @media (prefers-reduced-motion: reduce) {
    &.unmount {
      animation-duration: 0s;
      animation-delay: 0s;
    }
  }
`;

function staggerFooterExits(clone: HTMLElement): void {
  const exiting = Array.from(clone.parentElement?.children ?? []).filter(
    (child): child is HTMLButtonElement =>
      child instanceof HTMLButtonElement &&
      child.classList.contains('unmount') &&
      !child.hasAttribute('data-footer-exit-started'),
  );

  for (const [index, button] of exiting.entries()) {
    button.setAttribute('data-footer-exit-started', '');
    button.style.setProperty(
      '--footer-action-exit-delay',
      `${index * ACTION_EXIT_STAGGER}ms`,
    );
  }
}

export const ViewActionButton = ({
  visible,
  footerReveal = 'always',
  ...props
}: ComponentProps<typeof Button> & {visible: boolean}): ReactNode => {
  const presence = useRef<{
    visible: boolean;
    mounted: boolean;
    clone: HTMLElement | undefined;
  }>({visible, mounted: true, clone: undefined});

  useLayoutEffect(() => {
    presence.current.visible = visible;

    if (visible) {
      presence.current.clone?.remove();
      presence.current.clone = undefined;
    }
  }, [visible]);

  useLayoutEffect(() => {
    const state = presence.current;
    state.mounted = true;

    return () => {
      state.mounted = false;
      state.clone?.remove();
      state.clone = undefined;
    };
  }, []);

  return visible ? (
    <UnmountAnimationClone
      onUnmountClone={clone => {
        const state = presence.current;

        if (state.visible || !state.mounted) {
          clone.remove();
          return;
        }

        state.clone?.remove();
        state.clone = clone;
        clone.inert = true;
        clone.setAttribute('aria-hidden', 'true');
        clone.removeAttribute('id');
        staggerFooterExits(clone);
      }}
      onUnmountRemove={() => {
        if (!presence.current.clone?.isConnected) {
          presence.current.clone = undefined;
        }
      }}
    >
      <ActionButton
        {...props}
        footerReveal={footerReveal}
        data-animated-presence=""
      />
    </UnmountAnimationClone>
  ) : null;
};

const Container = styled(Buttons)<{$revealed: boolean}>`
  --button-disabled-background: rgba(255, 255, 255, 0.9);

  flex-shrink: 0;
  position: absolute;
  inset: auto 0 0;
  z-index: 1;

  margin: 0;
  padding: var(--view-padding) var(--view-padding) var(--view-padding-bottom);

  pointer-events: none;

  > * {
    pointer-events: auto;
  }

  > button[data-footer-reveal='end'],
  &[data-footer-reveal='end'] > button:not([data-footer-reveal='always']) {
    visibility: ${props => (props.$revealed ? 'visible' : 'hidden')};
    transform-origin: center bottom;
  }
`;

export const ViewFooter = ({
  ref,
  reveal,
  revealed,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  reveal: 'always' | 'end';
  revealed: boolean;
  ref?: Ref<HTMLDivElement>;
}): ReactNode => {
  const containerRef = useRef<HTMLDivElement>(null);
  const enteredRef = useRef(new Set<HTMLButtonElement | string>());
  const animationsRef = useRef(
    new Map<HTMLButtonElement | string, Animation>(),
  );

  useImperativeHandle(ref, () => containerRef.current!, []);

  useLayoutEffect(() => {
    const entered = enteredRef.current;
    const animations = animationsRef.current;

    return () => {
      for (const animation of animations.values()) animation.cancel();
      animations.clear();
      entered.clear();
    };
  }, []);

  useLayoutEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const container = containerRef.current!;
    const entered = enteredRef.current;
    const animations = animationsRef.current;
    const animateButtons = (): void => {
      let index = 0;

      for (const child of container.children) {
        if (
          !(child instanceof HTMLButtonElement) ||
          child.classList.contains('unmount')
        ) {
          continue;
        }

        const action = child.dataset.footerAction ?? child;
        if (entered.has(action)) {
          // Route activation can replace an action's button mid-animation.
          const effect = animations.get(action)?.effect;
          if (effect instanceof KeyframeEffect) effect.target = child;
          continue;
        }

        const when = child.dataset.footerReveal ?? reveal;
        if (
          when === 'end'
            ? !revealed
            : !child.hasAttribute('data-animated-presence')
        ) {
          continue;
        }

        entered.add(action);
        if (reducedMotion.matches) continue;

        const animation = child.animate(popInAnimation.keyframes, {
          ...popInAnimation.timing,
          delay: index++ * popInAnimation.stagger,
        });
        animations.set(action, animation);
        const forget = (): void => {
          if (animations.get(action) === animation) animations.delete(action);
        };
        void animation.finished.then(forget, forget);
      }
    };
    const observer = new MutationObserver(() => {
      animateButtons();

      for (const [action, animation] of animations) {
        const effect = animation.effect as KeyframeEffect;
        if (effect.target?.parentElement !== container) {
          animation.cancel();
          animations.delete(action);
        }
      }
    });

    animateButtons();
    // Only direct child changes affect action presence. Labels and disabled
    // state must not restart animations on buttons that are already visible.
    observer.observe(container, {childList: true});

    return () => {
      observer.disconnect();
    };
  }, [reveal, revealed]);

  return (
    <Container
      {...props}
      ref={containerRef}
      $revealed={revealed}
      data-footer-reveal={reveal}
    >
      {children}
    </Container>
  );
};
