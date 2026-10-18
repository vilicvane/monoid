import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {InputModalOptions} from '../@ui/use-input-modal.js';

const Kind = styled.span<{$safe: boolean}>`
  color: ${({$safe}) => ($safe ? 'var(--ion-color-warning)' : 'white')};
`;

export function PINKind({kind}: {kind: 'Access' | 'Safe'}): ReactNode {
  return <Kind $safe={kind === 'Safe'}>{kind}</Kind>;
}

export function getPINInputPlaceholder(
  kind: 'Access' | 'Safe',
  prefix = 'Enter',
): Pick<InputModalOptions, 'placeholder' | 'placeholderContent'> {
  return {
    placeholder: `${prefix} ${kind} PIN`,
    placeholderContent: (
      <>
        {prefix} <PINKind kind={kind} /> PIN
      </>
    ),
  };
}
