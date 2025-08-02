import classNames from 'classNames';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

const Container = styled.div``;

const Title = styled.div``;

const Summary = styled.div``;

const Content = styled.div``;

export const Step = ({
  title,
  active,
  summary,
  children,
}: {
  title: ReactNode;
  active: boolean;
  ready: boolean;
  summary?: string;
  children: ReactNode;
}): ReactNode => {
  return (
    <Container className={classNames({active})}>
      <Title>{title}</Title>
      {summary && <Summary>{summary}</Summary>}
      {active && <Content>{children}</Content>}
    </Container>
  );
};

export const Steps = styled.div``;
