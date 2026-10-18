import type {ReactNode, Ref} from 'react';
import {styled} from 'styled-components';

import monoidCardWirelessInterface from '../../@assets/monoid-card-wireless-interface.svg';
import monoidLogo from '../../@assets/monoid.svg';

export const MonoidCardFrame = styled.div`
  position: relative;
  aspect-ratio: 430 / 270;
  border-radius: calc(20 / 430 * 100%) / calc(20 / 270 * 100%);
  background-color: var(
    --monoid-card-background,
    var(--ion-color-dark-contrast)
  );
`;

const CardWirelessInterface = styled.img`
  position: absolute;
  top: calc(43 / 270 * 100%);
  left: calc(40 / 430 * 100%);
  width: calc(32 / 430 * 100%);
`;

const CardLogo = styled.img<{$error: boolean}>`
  position: absolute;
  top: calc(170 / 270 * 100%);
  right: 0;
  width: var(--monoid-card-logo-width, calc(60 / 430 * 100%));
  background-color: var(
    --ion-color-${props => (props.$error ? 'danger' : 'primary')}
  );
  transition: background-color 160ms ease-out;
`;

const CardId = styled.span`
  position: absolute;
  top: calc(43 / 270 * 100%);
  left: calc(40 / 430 * 100%);
  color: var(--ion-color-medium);
  font-size: 12px;
  font-weight: 400;
  line-height: 1;
  letter-spacing: 0.06em;
  white-space: nowrap;
  pointer-events: none;
`;

export function MonoidCard({
  className,
  children,
  error = false,
  id,
  ref,
}: {
  className?: string;
  children?: ReactNode;
  error?: boolean;
  id?: string;
  ref?: Ref<HTMLDivElement>;
}): ReactNode {
  return (
    <MonoidCardFrame className={className} ref={ref}>
      {children}
      {id ? (
        <CardId>{id}</CardId>
      ) : (
        <CardWirelessInterface src={monoidCardWirelessInterface} alt="" />
      )}
      <CardLogo src={monoidLogo} alt="" $error={error} />
    </MonoidCardFrame>
  );
}
