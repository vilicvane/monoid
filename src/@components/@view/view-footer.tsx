import type {HTMLAttributes, ReactNode, Ref} from 'react';
import {css, styled} from 'styled-components';

import {Buttons} from '../@ui/button.js';

const BLUR_STEPS = 4;
const MAX_BLUR_RADIUS = 2;

const BlurLayer = styled.div<{$step: number}>`
  position: absolute;
  inset: 0 0 calc(var(--nav-bar-height) + var(--view-inset-bottom));
  z-index: -1;
  pointer-events: none;

  /* Blur variances add; keep the combined radius within the shared maximum. */
  backdrop-filter: blur(
    ${({$step}) => Math.sqrt(2 * $step - 1) * (MAX_BLUR_RADIUS / BLUR_STEPS)}px
  );
  mask-image: linear-gradient(
    to bottom,
    transparent ${({$step}) => (($step - 1) / BLUR_STEPS) * 100}%,
    black ${({$step}) => ($step / BLUR_STEPS) * 100}%
  );
`;

const Container = styled(Buttons)<{$fixed: boolean}>`
  flex-shrink: 0;

  ${props =>
    props.$fixed &&
    css`
      --button-disabled-background: rgba(255, 255, 255, 0.9);

      position: absolute;
      inset: auto 0 0;
      z-index: 1;

      margin: 0;
      padding: var(--view-padding) calc(var(--view-padding) - 2px)
        var(--view-padding-bottom);

      pointer-events: none;

      > :not(${BlurLayer}) {
        pointer-events: auto;
      }
    `}
`;

export const ViewFooter = ({
  placement,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  placement: 'scroll' | 'fixed';
  ref?: Ref<HTMLDivElement>;
}): ReactNode => {
  return (
    <Container {...props} $fixed={placement === 'fixed'}>
      {placement === 'fixed' &&
        Array.from({length: BLUR_STEPS}, (_, index) => (
          <BlurLayer key={index} $step={index + 1} aria-hidden="true" />
        ))}
      {children}
    </Container>
  );
};
