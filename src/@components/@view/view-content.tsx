import {runInAction} from 'mobx';
import {
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {styled} from 'styled-components';

import {ViewContext} from './@view-context.js';
import {ViewFooter} from './view-footer.js';

const Container = styled.div<{$hasFooter: boolean; $sectionGap: number}>`
  --view-section-gap: ${props => props.$sectionGap}px;

  flex: 1 1 auto;
  height: 0;
  overflow-y: auto;
  padding: 8px var(--view-padding)
    ${props =>
      props.$hasFooter
        ? 'var(--view-footer-height, var(--view-padding-bottom))'
        : 'var(--view-padding-bottom)'};
  scroll-padding-bottom: ${props =>
    props.$hasFooter
      ? 'var(--view-footer-height, var(--view-padding-bottom))'
      : 'var(--view-padding-bottom)'};

  display: flex;
  flex-direction: column;
  gap: 8px;
`;

export const ViewContent = ({
  footer,
  footerReveal = 'always',
  footerRef,
  sectionGap = 24,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  footer?: ReactNode;
  footerReveal?: 'always' | 'end';
  footerRef?: Ref<HTMLDivElement>;
  sectionGap?: number;
}): ReactNode => {
  const context = useContext(ViewContext);
  const containerRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const hasFooter = !!footer;
  const [footerRevealed, setFooterRevealed] = useState(false);

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

      const actions = actionsRef.current;
      if (footerRevealed || !actions) return;

      const contentStyle = getComputedStyle(container);
      const footerStyle = getComputedStyle(actions);
      const contentBottom =
        container.scrollHeight -
        parseFloat(contentStyle.paddingBottom) -
        container.scrollTop;
      const visibleAction = Array.from(actions.children).find(
        (child): child is HTMLButtonElement =>
          child instanceof HTMLButtonElement &&
          getComputedStyle(child).visibility !== 'hidden',
      );
      // Reading ends above persistent actions, or above the navigation bar.
      const visibleHeight = visibleAction
        ? actions.getBoundingClientRect().top +
          visibleAction.offsetTop -
          parseFloat(footerStyle.paddingTop) -
          container.getBoundingClientRect().top
        : container.clientHeight -
          parseFloat(footerStyle.paddingBottom) +
          parseFloat(footerStyle.paddingTop);

      if (contentBottom <= visibleHeight) setFooterRevealed(true);
    },
    [context, footerRevealed],
  );

  useLayoutEffect(() => {
    const container = containerRef.current!;
    if (!hasFooter) {
      container.style.removeProperty('--view-footer-height');
      return;
    }

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
    };
  }, [hasFooter, updateScrollState]);

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
    <ViewFooter
      ref={attachFooter}
      reveal={footerReveal}
      revealed={footerRevealed}
    >
      {footer}
    </ViewFooter>
  );

  return (
    <>
      <Container
        {...props}
        ref={containerRef}
        $hasFooter={hasFooter}
        $sectionGap={sectionGap}
        onScroll={event => {
          updateScrollState(event.currentTarget);
          props.onScroll?.(event);
        }}
      >
        {children}
      </Container>
      {actions}
    </>
  );
};
