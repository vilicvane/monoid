import classNames from 'classNames';
import type {LucideIcon} from 'lucide-react';
import {CreditCard as creditCard, Key as key} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import type {HTMLAttributes, ReactNode} from 'react';
import {useContext} from 'react';
import {css, styled} from 'styled-components';

import type {MonoidIdHex, SafeIndexHex} from '../../@atomics.js';
import {AppIcon} from '../@ui/app-icon.js';
import {IconButton} from '../@ui/icon-button.js';
import {WhiteTag, leadingIconTagCSS} from '../@ui/tag.js';

import {scrollBorderCSS} from './@scroll-border.js';
import {ViewContext} from './@view-context.js';

export const ViewHeaderTitle = styled.h1`
  margin: 0;
`;

export const ViewHeaderButton = styled(IconButton).attrs({feedback: 'color'})`
  grid-column: 3;
  align-self: center;
  justify-self: end;
  margin-right: -8px;
  font-size: 20px;
`;

export const viewHeaderTagCSS = css`
  --icon-stroke-width: 1;
  --view-header-tag-optical-offset: 2px;

  justify-self: start;
  min-width: 0;
  max-width: 100%;
  margin: 0;

  /* Align the border to the text edge, then apply the tag's optical offset. */
  contain: layout;
  transform: translateY(
    calc(
      var(--view-header-text-edge-offset) +
        var(--view-header-tag-optical-offset)
    )
  );

  &[type='button'] {
    cursor: pointer;
  }
`;

const IdentifierContainer = styled(WhiteTag)`
  ${viewHeaderTagCSS}
  ${leadingIconTagCSS}

  grid-column: 2;
  width: max-content;
  max-width: none;
  z-index: 1;
  border-radius: 4px;
`;

const ViewHeaderContainer = styled.div`
  /* Match the visible text edge below the current title font's baseline. */
  --view-header-text-edge-offset: 1px;
  --view-header-gap: 8px;

  flex: 0;

  box-sizing: content-box;
  padding: var(--view-padding-top) var(--view-padding) 8px;
  height: 50px;

  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  /* Keep optional 32px header buttons from changing the content position. */
  grid-template-rows: minmax(32px, auto);
  align-content: center;
  align-items: baseline;
  gap: var(--view-header-gap);

  &:has(> ${IdentifierContainer}) {
    grid-template-columns: auto auto minmax(0, 1fr);
  }

  > ${IdentifierContainer} + :not(${ViewHeaderButton}) {
    margin-left: calc(-1 * var(--view-header-gap) - var(--tag-overlap));
  }

  border-bottom: solid 0.5px transparent;

  ${scrollBorderCSS}
`;

export const ViewHeader = observer(
  ({className, ...props}: HTMLAttributes<HTMLDivElement>): ReactNode => {
    const {scrolled} = useContext(ViewContext);

    return (
      <ViewHeaderContainer
        className={classNames(className, {scrolled})}
        {...props}
      />
    );
  },
);

const IdentifierIcon = styled(AppIcon)`
  flex-shrink: 0;
  color: var(--ion-color-medium-tint);
`;

const Identifier = styled.span`
  flex-shrink: 0;
  white-space: nowrap;

  color: var(--ion-color-medium);
`;

const INDEX_DISPLAY_OFFSET = 2;
const INDEX_DISPLAY_END = INDEX_DISPLAY_OFFSET + 8;

export const ViewHeaderIdentifier = ({
  className,
  identifier,
  onClick,
  'aria-label': ariaLabel,
}: {
  className?: string;
  onClick?: () => void;
  'aria-label'?: string;
  identifier:
    | {
        type: 'card';
        id: MonoidIdHex;
      }
    | {
        type: 'safe-item';
        index: SafeIndexHex;
      };
}): ReactNode => {
  let icon: LucideIcon;
  let children: string;

  switch (identifier.type) {
    case 'card':
      icon = creditCard;
      children = identifier.id;
      break;
    case 'safe-item':
      icon = key;
      children = identifier.index.slice(
        INDEX_DISPLAY_OFFSET,
        INDEX_DISPLAY_END,
      );
      break;
  }

  return (
    <IdentifierContainer
      className={className}
      as={onClick ? 'button' : 'div'}
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      <IdentifierIcon icon={icon} />
      <Identifier>{children}</Identifier>
    </IdentifierContainer>
  );
};
