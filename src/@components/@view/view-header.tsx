import {IonIcon} from '@ionic/react';
import classNames from 'classNames';
import creditCard from 'lucide-static/icons/credit-card.svg';
import keyRound from 'lucide-static/icons/key-round.svg';
import {observer} from 'mobx-react-lite';
import type {HTMLAttributes, ReactNode} from 'react';
import {useContext} from 'react';
import {styled} from 'styled-components';

import type {
  MonoidIdHex,
  MonoidSafeIdHex,
  SafeIndexHex,
} from '../../@atomics.js';

import {ViewContext} from './@view-context.js';

const ViewHeaderContainer = styled.div`
  flex: 0;

  box-sizing: content-box;
  padding: var(--view-padding-top) var(--view-padding) var(--view-padding);
  height: 50px;

  display: flex;
  align-items: center;
  justify-content: space-between;

  border-bottom: solid 0.5px transparent;

  transition: border-color 0.2s linear;

  &.scrolled {
    border-color: var(--ion-color-light-shade);
  }
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

const IdentifierContainer = styled.div`
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
  color: var(--ion-color-medium-tint);
`;

const Identifier = styled.span`
  font-size: 14px;
  color: var(--ion-color-medium);
`;

const INDEX_DISPLAY_OFFSET = 2;
const INDEX_DISPLAY_END = INDEX_DISPLAY_OFFSET + 8;

export const ViewHeaderIdentifier = ({
  identifier,
}: {
  identifier:
    | {
        type: 'card';
        id: MonoidSafeIdHex;
      }
    | {
        type: 'safe-item';
        index: SafeIndexHex;
        alias?: string;
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
      icon = keyRound;
      children =
        identifier.alias ??
        identifier.index.slice(INDEX_DISPLAY_OFFSET, INDEX_DISPLAY_END);
      break;
  }

  return (
    <IdentifierContainer>
      <IdentifierIcon icon={icon} />
      <Identifier>{children}</Identifier>
    </IdentifierContainer>
  );
};
