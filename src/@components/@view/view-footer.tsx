import classNames from 'classNames';
import {observer} from 'mobx-react-lite';
import {type HTMLAttributes, type ReactNode, type Ref, useContext} from 'react';
import {css, styled} from 'styled-components';

import {Buttons} from '../@ui/button.js';

import {scrollBorderCSS} from './@scroll-border.js';
import {ViewContext} from './@view-context.js';

const Container = styled(Buttons)<{$fixed: boolean}>`
  flex-shrink: 0;

  ${props =>
    props.$fixed &&
    css`
      margin: 0;
      padding: var(--view-padding) calc(var(--view-padding) - 2px)
        var(--view-padding-bottom);
      border-top: solid 0.5px transparent;

      ${scrollBorderCSS}
    `}
`;

export const ViewFooter = observer(
  ({
    placement,
    className,
    ...props
  }: HTMLAttributes<HTMLDivElement> & {
    placement: 'scroll' | 'fixed';
    ref?: Ref<HTMLDivElement>;
  }): ReactNode => {
    const {canScrollDown} = useContext(ViewContext);

    return (
      <Container
        {...props}
        $fixed={placement === 'fixed'}
        className={classNames(className, {
          scrolled: placement === 'fixed' && canScrollDown,
        })}
      />
    );
  },
);
