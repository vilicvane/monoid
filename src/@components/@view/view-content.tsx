import {runInAction} from 'mobx';
import {
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
} from 'react';
import {styled} from 'styled-components';

import {ViewContext} from './@view-context.js';
import {ViewFooter} from './view-footer.js';

const Container = styled.div<{$fixedFooter: boolean}>`
  flex: 1 1 auto;
  height: 0;
  overflow-y: auto;
  padding: 8px var(--view-padding)
    ${props =>
      props.$fixedFooter
        ? 'var(--view-padding)'
        : 'var(--view-padding-bottom)'};

  display: flex;
  flex-direction: column;
  gap: 8px;
`;

export const ViewContent = ({
  footer,
  footerPlacement = 'scroll',
  footerRef,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  footer?: ReactNode;
  footerPlacement?: 'scroll' | 'fixed';
  footerRef?: Ref<HTMLDivElement>;
}): ReactNode => {
  const context = useContext(ViewContext);
  const containerRef = useRef<HTMLDivElement>(null);
  const fixedFooter = !!footer && footerPlacement === 'fixed';

  const updateScrollState = useCallback(
    (container: HTMLElement): void => {
      const {scrollTop, scrollHeight, clientHeight} = container;

      runInAction(() => {
        context.scrolled = scrollTop > 0;
        context.canScrollDown = scrollHeight - clientHeight - scrollTop > 1;
      });
    },
    [context],
  );

  useLayoutEffect(() => {
    const container = containerRef.current!;
    const resizeObserver = new ResizeObserver(() =>
      updateScrollState(container),
    );
    const observeContent = (): void => {
      resizeObserver.disconnect();
      resizeObserver.observe(container);
      for (const child of container.children) resizeObserver.observe(child);
      updateScrollState(container);
    };
    const mutationObserver = new MutationObserver(observeContent);

    observeContent();
    mutationObserver.observe(container, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [updateScrollState]);

  const actions = footer && (
    <ViewFooter placement={footerPlacement} ref={footerRef}>
      {footer}
    </ViewFooter>
  );

  return (
    <>
      <Container
        {...props}
        ref={containerRef}
        $fixedFooter={fixedFooter}
        onScroll={event => {
          updateScrollState(event.currentTarget);
          props.onScroll?.(event);
        }}
      >
        {children}
        {!fixedFooter && actions}
      </Container>
      {fixedFooter && actions}
    </>
  );
};
