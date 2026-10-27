// Match the APP button presentation without importing its service container.
import classNames from 'classNames';
import type {ButtonHTMLAttributes, ReactNode} from 'react';
import {styled} from 'styled-components';

import {LoadingSpinner} from '../../../../src/@components/@ui/loading-spinner.js';
import {RippleEffect} from '../../../../src/@components/@ui/ripple-effect.js';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  color?: 'primary' | 'danger' | 'warning' | 'neutral';
  loading?: boolean;
  footerReveal?: 'always' | 'end';
};

export const Buttons = styled.div`
  margin: auto 0 0;

  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const Container = styled.button<{$color: NonNullable<ButtonProps['color']>}>`
  position: relative;
  isolation: isolate;

  height: 40px;
  margin: 0 -2px;

  background-color: var(--ion-color-${props => props.$color});
  border: solid 0.5px var(--ion-color-${props => props.$color}-shade);
  color: var(--ion-color-${props => props.$color}-contrast);
  border-radius: 20px;
  overflow: hidden;
  font-size: 16px;

  transition:
    background-color 0.2s linear,
    border-color 0.2s linear,
    color 0.2s linear;

  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;

  > ion-ripple-effect {
    z-index: -1;
    color: black;
    /* Ionic's ripple animation peaks at 0.16 opacity. */
    opacity: calc(0.05 / 0.16);
  }

  &:disabled {
    background-color: var(--button-disabled-background, transparent);
    border-color: var(--ion-color-light-shade);
    color: var(--ion-color-medium-tint);
  }
`;

const LoadingContent = styled.span<{$loading: boolean}>`
  position: relative;

  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;

  /* Keep the label and its 16px spinner centered as one group. */
  transform: translateX(${props => (props.$loading ? 12 : 0)}px);
  transition: transform 0.16s ease;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

const Spinner = styled(LoadingSpinner)`
  position: absolute;
  right: calc(100% + 8px);
  top: 50%;
  transform: translateY(-50%);

  width: 16px;
  height: 16px;

  transition: opacity 0.16s ease;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

export const Button = ({
  className,
  color = 'primary',
  disabled,
  loading,
  footerReveal,
  children,
  ...props
}: ButtonProps): ReactNode => {
  return (
    <Container
      className={classNames(className, 'ion-activatable')}
      $color={color}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-footer-reveal={footerReveal}
      {...props}
    >
      {loading === undefined ? (
        children
      ) : (
        <LoadingContent $loading={loading}>
          <Spinner paused={!loading} style={{opacity: loading ? 1 : 0}} />
          {children}
        </LoadingContent>
      )}
      {!disabled && !loading && <RippleEffect />}
    </Container>
  );
};
