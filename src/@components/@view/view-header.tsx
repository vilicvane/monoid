import {IonIcon} from '@ionic/react';
import classNames from 'classNames';
import creditCard from 'lucide-static/icons/credit-card.svg';
import key from 'lucide-static/icons/key.svg';
import {observer} from 'mobx-react-lite';
import type {HTMLAttributes, ReactNode} from 'react';
import {useContext} from 'react';
import {css, styled} from 'styled-components';

import type {MonoidSafeIdHex, SafeIndexHex} from '../../@atomics.js';

import {scrollBorderCSS} from './@scroll-border.js';
import {ViewContext} from './@view-context.js';

const ViewHeaderContainer = styled.div`
  /* Match the visible text edge below the current title font's baseline. */
  --view-header-text-edge-offset: 1px;

  flex: 0;

  box-sizing: content-box;
  padding: var(--view-padding-top) var(--view-padding) var(--view-padding);
  height: 50px;

  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-content: center;
  align-items: baseline;
  gap: 10px;

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

export const ViewHeaderTitle = styled.h1`
  margin: 0;
`;

export const viewHeaderTagCSS = css`
  --view-header-tag-optical-offset: 1px;

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

const IdentifierContainer = styled.div`
  ${viewHeaderTagCSS}

  grid-column: 3;
  background-color: var(--ion-color-light);
  border-radius: 4px;

  height: 24px;
  padding: 0 6px 0 4px;
  border: solid 0.5px var(--ion-color-light-shade);

  display: flex;
  align-items: center;
  gap: 4px;
`;

const IdentifierIcon = styled(IonIcon)`
  flex-shrink: 0;
  color: var(--ion-color-medium-tint);
`;

const Identifier = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  font-size: 14px;
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
        id: MonoidSafeIdHex;
      }
    | {
        type: 'safe-item';
        index: SafeIndexHex;
      };
}): ReactNode => {
  let icon: string;
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
