import type {ButtonHTMLAttributes, ReactNode} from 'react';
import {css, styled} from 'styled-components';

import type {AddressChain} from '../../@lib/wallet-address.js';
import {collapseOutAnimationCSS, popInAnimationCSS} from '../@animations.js';
import {PrimaryTag, Tag} from '../@ui/tag.js';

import {AddressChainIcon} from './address-chain-icon.js';

export const KeyTags = styled.div`
  display: flex;
  gap: var(--key-item-gap);
  align-items: center;
  isolation: isolate;
`;

export const KeyTag = Tag;

const overlappingKeyTagCSS = css`
  margin-left: calc(
    -1 * var(--key-item-gap) - var(--tag-overlap) - var(--tag-inline-margin)
  );
`;

export const KeyTypeTag = styled(KeyTag)`
  z-index: 1;

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

export const KeyAliasTag = styled(PrimaryTag)`
  border-color: transparent;
  flex-shrink: 1;
  min-width: 0;
  display: block;
  align-content: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 20px;

  ${KeyTypeTag} + & {
    ${overlappingKeyTagCSS}
  }
`;

const KeyDerivationTagContainer = styled(KeyTag)`
  gap: 2px;
  padding-left: 3px;

  background-color: var(
    --color-address-tag-background,
    var(--ion-color-dark-contrast)
  );
  border-color: var(--color-address-tag-border, var(--ion-color-light-shade));
  color: var(--color-address-tag-text, var(--ion-color-dark));
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
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement> & {
    'data-swipeable-content'?: boolean;
  };
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

export const KeyDerivationBadge = styled(KeyTag)<{
  $primary?: boolean;
  $revealing?: boolean;
}>`
  ${overlappingKeyTagCSS}
  height: 20px;
  width: 20px;
  padding: 0;
  font-size: 11px;

  background-color: ${({$primary}) =>
    $primary ? 'var(--ion-color-primary)' : 'var(--color-derivations-badge)'};
  border-color: transparent;
  color: ${({$primary}) =>
    $primary
      ? 'var(--ion-color-primary-contrast)'
      : 'var(--color-derivations-badge-contrast)'};

  z-index: -1;

  & + & {
    z-index: -2;
  }

  ${({$revealing}) =>
    $revealing &&
    css`
      transform-origin: left center;
      ${popInAnimationCSS}
    `}

  &.unmount {
    // React can replace the preceding path with a button during the same commit.
    order: 1;
    transform-origin: left center;
    ${collapseOutAnimationCSS}
    pointer-events: none;
  }

  @media (prefers-reduced-motion: reduce) {
    & {
      animation: none;
    }

    &.unmount {
      animation-duration: 0s;
    }
  }
`;
