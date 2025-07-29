import {IonIcon} from '@ionic/react';
import classNames from 'classNames';
import {observer} from 'mobx-react-lite';
import type {HTMLAttributes, ReactNode} from 'react';
import {useContext} from 'react';
import {styled} from 'styled-components';

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

export const ViewHeaderIdentifier = ({
  icon,
  children,
}: {
  icon: string;
  children: ReactNode;
}): ReactNode => {
  return (
    <IdentifierContainer>
      <IdentifierIcon icon={icon} />
      <Identifier>{children}</Identifier>
    </IdentifierContainer>
  );
};
