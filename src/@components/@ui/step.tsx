import classNames from 'classNames';
import {Check as check} from 'lucide-react';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {AppIcon} from './app-icon.js';
import {LoadingSpinner} from './loading-spinner.js';

export const Steps = styled.div`
  --gap: 16px;

  display: flex;
  flex-direction: column;
  gap: var(--gap);
`;

const Container = styled.div`
  --indicator-center-left-offset: 10px;
  --indicator-line-width: 1px;
  --indicator-size: 20px;
  --title-height: 20px;
  --indicator-color: var(--ion-color-primary);
  --indicator-line-color: var(--ion-color-light-shade);

  --indicator-line-left-offset: calc(
    var(--indicator-center-left-offset) - var(--indicator-line-width) / 2
  );

  display: flex;
  flex-direction: column;
  gap: 8px;

  padding-left: 32px;

  position: relative;

  &.done {
    --indicator-color: var(--ion-color-safe);
    --indicator-line-color: var(--ion-color-safe);
  }

  &.pending {
    --indicator-color: var(--ion-color-light-shade);
  }

  &:not(:last-child)::after {
    content: '';
    position: absolute;

    left: var(--indicator-line-left-offset);
    top: calc(var(--title-height) / 2);

    bottom: calc(-1 * (var(--title-height) / 2 + var(--gap)));
    width: var(--indicator-line-width);
    background-color: var(--indicator-line-color);
  }

  &.done:has(+ .active)::after {
    background-image: linear-gradient(
      to bottom,
      var(--ion-color-safe),
      var(--ion-color-primary)
    );
  }

  &:has(+ .pending)::after {
    mask-image: repeating-linear-gradient(
      to bottom,
      black 0 3px,
      transparent 3px 5px
    );
  }
`;

const Title = styled.div`
  line-height: var(--title-height);

  ${Container}:not(.active) & {
    color: var(--color-text-secondary);
  }
`;

const Summary = styled.div`
  color: var(--color-text-dim);
`;

const Content = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;

  color: var(--color-text-secondary);
`;

const Indicator = styled.div`
  position: absolute;

  left: calc(var(--indicator-center-left-offset) - var(--indicator-size) / 2);
  top: calc(var(--title-height) / 2 - var(--indicator-size) / 2);

  width: var(--indicator-size);
  height: var(--indicator-size);
  border-radius: 50%;

  background-color: var(--indicator-color);
  color: var(--ion-color-primary-contrast);
  font-size: 12px;

  transition: all 0.2s linear;

  z-index: 1;

  display: flex;
  align-items: center;
  justify-content: center;
`;

const Spinner = styled(LoadingSpinner)`
  width: 12px;
  height: 12px;
`;

export const Step = ({
  title,
  numero,
  activeNumero,
  processing = false,
  summary,
  children,
}: {
  title: ReactNode;
  numero: number;
  processing?: boolean;
  activeNumero: number;
  summary?: ReactNode;
  children?: ReactNode;
}): ReactNode => {
  const state =
    numero === activeNumero
      ? 'active'
      : numero < activeNumero
        ? 'done'
        : 'pending';

  let indicator: ReactNode;

  if (processing) {
    indicator = <Spinner />;
  } else {
    switch (state) {
      case 'active':
      case 'pending':
        indicator = numero;
        break;
      case 'done':
        indicator = <AppIcon icon={check} />;
        break;
    }
  }

  return (
    <Container
      className={classNames({
        [state]: true,
      })}
    >
      <Indicator>{indicator}</Indicator>
      <Title>{title}</Title>
      {state === 'done' && summary && <Summary>{summary}</Summary>}
      {state === 'active' && <Content>{children}</Content>}
    </Container>
  );
};
