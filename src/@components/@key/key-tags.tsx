import type {ButtonHTMLAttributes, ReactNode} from 'react';
import {styled} from 'styled-components';

import type {AddressChain} from '../../@lib/wallet-address.js';

import {AddressChainIcon} from './address-chain-icon.js';

export const KeyTags = styled.div`
  display: flex;
  gap: 10px;
  align-items: center;
`;

export const KeyTag = styled.div`
  flex-shrink: 0;
  margin: 0 -2px;

  height: 22px;
  padding: 0 6px;
  font-size: 13px;
  border-radius: 12px;

  background-color: var(--ion-color-light);
  border: solid 0.5px var(--ion-color-light-shade);
  color: var(--ion-color-medium-shade);

  display: flex;
  align-items: center;
  justify-content: center;
`;

export const KeyTypeTag = styled(KeyTag)`
  &.seed {
    background-color: var(--color-seed-light);
    border-color: var(--color-seed-light-shade);
    color: var(--color-seed-light-contrast);
  }

  &.master {
    background-color: var(--color-master-light);
    border-color: var(--color-master-light-shade);
    color: var(--color-master-light-contrast);
  }
`;

export const KeyAliasTag = styled(KeyTag)`
  flex-shrink: 1;
  min-width: 0;
  display: block;
  align-content: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 20px;

  background-color: var(--ion-color-primary);
  border-color: var(--ion-color-primary-shade);
  color: var(--ion-color-primary-contrast);
`;

const KeyDerivationTagContainer = styled(KeyTag)`
  gap: 2px;
  padding-left: 3px;

  background-color: var(--ion-color-dark-contrast);
  border-color: var(--ion-color-light-shade);
  color: var(--ion-color-dark);
`;

const DerivationPath = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

export const KeyDerivationTag = ({
  chain,
  className,
  children,
  buttonProps,
}: {
  chain: AddressChain;
  className?: string;
  children: ReactNode;
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement>;
}): ReactNode => (
  <KeyDerivationTagContainer
    {...buttonProps}
    as={buttonProps ? 'button' : 'div'}
    className={className}
  >
    <AddressChainIcon chain={chain} />
    <DerivationPath>{children}</DerivationPath>
  </KeyDerivationTagContainer>
);

export const KeyDerivationBadge = styled(KeyTag)`
  margin-left: -12px;
  height: 20px;
  width: 20px;
  padding: 0;
  font-size: 11px;

  background-color: var(--color-derivations-badge);
  border-color: transparent;
  color: var(--color-derivations-badge-contrast);

  z-index: -1;
`;
