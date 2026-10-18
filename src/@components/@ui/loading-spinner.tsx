import {LoaderCircle as loaderCircle} from 'lucide-react';
import type {ComponentProps, ReactNode} from 'react';
import {styled} from 'styled-components';

import {spinAnimationCSS} from '../@animations.js';

import {AppIcon} from './app-icon.js';

const Container = styled.span.attrs({
  'aria-hidden': true,
})`
  display: inline-flex;
  flex-shrink: 0;
  width: 1em;
  height: 1em;
  vertical-align: middle;
  pointer-events: none;
`;

const Icon = styled(AppIcon)<{$paused: boolean}>`
  ${spinAnimationCSS}
  width: 100%;
  height: 100%;
  animation-play-state: ${props => (props.$paused ? 'paused' : 'running')};
`;

export function LoadingSpinner({
  paused = false,
  ...props
}: ComponentProps<'span'> & {paused?: boolean}): ReactNode {
  return (
    <Container {...props}>
      {/* Rotate separately from callers' positioning and transition transforms. */}
      <Icon icon={loaderCircle} $paused={paused} />
    </Container>
  );
}
