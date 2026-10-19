import type {ReactNode} from 'react';
import {styled} from 'styled-components';

const Keyword = styled.strong`
  color: var(--ion-color-primary);
  font-weight: 500;
`;

export function QrScanInstructions({
  active,
  className,
}: {
  active: boolean;
  className?: string;
}): ReactNode {
  return (
    <Keyword className={className} aria-hidden={!active}>
      WalletConnect
    </Keyword>
  );
}
