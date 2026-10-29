// Mirror the APP completion with direct UI imports, without its service container.
import {CircleCheck as circleCheck} from 'lucide-react';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {
  fadeInAnimationCSS,
  popInAnimationCSS,
} from '../../../../src/@components/@animations.js';
import {ViewPlaceholder} from '../../../../src/@components/@view/view-placeholder.js';

import {AppIcon} from '../../../../src/@components/@ui/app-icon.js';

const Completion = styled(ViewPlaceholder)`
  flex-direction: column;
  gap: 16px;
  color: var(--ion-color-dark);
  font-size: 16px;
`;

const CompletionIcon = styled.span`
  --icon-stroke-width: 3px;

  ${popInAnimationCSS}
  animation-duration: 300ms;
  animation-timing-function: ease-in;
  display: flex;
  font-size: 96px;
  color: var(--ion-color-safe);

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const CompletionLabel = styled.span`
  ${fadeInAnimationCSS}
  animation-timing-function: ease-out;
  animation-delay: 280ms;
  animation-fill-mode: both;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

export function OperationComplete({
  label = 'Complete',
}: {
  label?: string;
}): ReactNode {
  return (
    <Completion role="status">
      <CompletionIcon aria-hidden="true">
        <AppIcon icon={circleCheck} />
      </CompletionIcon>
      <CompletionLabel>{label}</CompletionLabel>
    </Completion>
  );
}
