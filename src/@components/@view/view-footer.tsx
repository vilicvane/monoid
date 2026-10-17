import {
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';
import {styled} from 'styled-components';

import {popInAnimation} from '../@animations.js';
import {Buttons} from '../@ui/button.js';

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

  useImperativeHandle(ref, () => containerRef.current!, []);

  useLayoutEffect(() => {
    if (
      !revealed ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;

    const buttons = Array.from(containerRef.current!.children).filter(
      (child): child is HTMLButtonElement =>
        child instanceof HTMLButtonElement &&
        (child.dataset.footerReveal ?? reveal) === 'end',
    );
    const animations = buttons.map((button, index) =>
      button.animate(popInAnimation.keyframes, {
        ...popInAnimation.timing,
        delay: index * popInAnimation.stagger,
      }),
    );

    return () => {
      for (const animation of animations) animation.cancel();
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
