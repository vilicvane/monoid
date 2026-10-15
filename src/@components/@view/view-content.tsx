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
        ? 'var(--view-footer-height, var(--view-padding-bottom))'
        : 'var(--view-padding-bottom)'};
  scroll-padding-bottom: ${props =>
    props.$fixedFooter
      ? 'var(--view-footer-height, var(--view-padding-bottom))'
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
  const actionsRef = useRef<HTMLDivElement>(null);
  const fixedFooter = !!footer && footerPlacement === 'fixed';

  const attachFooter = useCallback(
    (element: HTMLDivElement | null) => {
      actionsRef.current = element;
      const cleanup =
        typeof footerRef === 'function' ? footerRef(element) : undefined;
      if (footerRef && typeof footerRef !== 'function') {
        footerRef.current = element;
      }

      return () => {
        actionsRef.current = null;
        if (typeof cleanup === 'function') cleanup();
        else if (typeof footerRef === 'function') footerRef(null);
        else if (footerRef) footerRef.current = null;
      };
    },
    [footerRef],
  );

  const updateScrollState = useCallback(
    (container: HTMLElement): void => {
      runInAction(() => {
        context.scrolled = container.scrollTop > 0;
      });
    },
    [context],
  );

  useLayoutEffect(() => {
    if (!fixedFooter) return;

    const container = containerRef.current!;
    const actions = actionsRef.current!;
    const updateFooterHeight = (): void => {
      // The footer's top padding also supplies the gap after the last item.
      container.style.setProperty(
        '--view-footer-height',
        `${actions.getBoundingClientRect().height}px`,
      );
      updateScrollState(container);
    };
    const resizeObserver = new ResizeObserver(updateFooterHeight);

    updateFooterHeight();
    resizeObserver.observe(actions, {box: 'border-box'});

    return () => {
      resizeObserver.disconnect();
      container.style.removeProperty('--view-footer-height');
    };
  }, [fixedFooter, updateScrollState]);

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
    <ViewFooter placement={footerPlacement} ref={attachFooter}>
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
