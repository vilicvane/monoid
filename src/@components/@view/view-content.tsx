import {runInAction} from 'mobx';
import {type HTMLAttributes, type ReactNode, useContext} from 'react';
import {styled} from 'styled-components';

import {ViewContext} from './@view-context.js';

const Container = styled.div`
  flex: 1 1 auto;
  height: 0;
  overflow-y: auto;
  padding: 8px var(--view-padding) var(--view-padding-bottom);

  display: flex;
  flex-direction: column;
  gap: 8px;
`;

export const ViewContent = (
  props: HTMLAttributes<HTMLDivElement>,
): ReactNode => {
  const context = useContext(ViewContext);

  return (
    <Container
      {...props}
      onScroll={event => {
        const target = event.target as HTMLElement;

        const scrolled = target.scrollTop > 0;

        runInAction(() => {
          context.scrolled = scrolled;
        });

        props.onScroll?.(event);
      }}
    />
  );
};
