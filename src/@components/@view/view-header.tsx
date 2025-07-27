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
