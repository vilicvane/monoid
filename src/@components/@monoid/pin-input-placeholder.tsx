import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {InputModalOptions} from '../@ui/use-input-modal.js';

const Kind = styled.span<{$secret: boolean}>`
  color: ${({$secret}) => ($secret ? 'var(--ion-color-warning)' : 'white')};
`;

export function PINKind({kind}: {kind: 'Access' | 'Secret'}): ReactNode {
  return <Kind $secret={kind === 'Secret'}>{kind}</Kind>;
}

export function getPINInputPlaceholder(
  kind: 'Access' | 'Secret',
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
