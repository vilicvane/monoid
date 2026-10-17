import type {HTMLProps, ReactNode} from 'react';
import {useLayoutEffect, useRef} from 'react';
import {styled} from 'styled-components';

import type {HighlightRange} from './highlighted-text.js';
import {decorateHighlightedText} from './highlighted-text.js';

const Container = styled.div`
  display: flex;
  justify-content: var(--ellipsis-alignment, space-between);
  overflow: hidden;
  white-space: nowrap;
`;

const Text = styled.span``;

const Left = styled(Text)`
  white-space: nowrap;
`;

const Right = styled(Text)``;

const Ellipsis = styled.span`
  flex-shrink: 0;
`;

export const EllipsisInMiddle = ({
  children: text,
  ellipsis = '...',
  highlightRanges,
  ...props
}: {
  children: string;
  ellipsis?: string;
  highlightRanges?: readonly HighlightRange[];
} & Omit<HTMLProps<HTMLDivElement>, 'children'>): ReactNode => {
  const containerRef = useRef<HTMLDivElement>(null);

  const leftRef = useRef<HTMLSpanElement>(null);
  const rightRef = useRef<HTMLSpanElement>(null);
  const ellipsisRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current!;
    const left = leftRef.current!;
    const right = rightRef.current!;
    const ellipsis = ellipsisRef.current!;

    update();

    const observer = new ResizeObserver(update);

    observer.observe(container);

    return () => {
      observer.disconnect();
    };

    function update(): void {
      left.style.display = 'none';
      right.style.display = 'none';
      ellipsis.style.display = 'none';

      const containerWidth = container.offsetWidth;

      left.style.display = '';
      left.textContent = text;

      if (left.offsetWidth <= containerWidth) {
        if (highlightRanges) decorateHighlightedText(left, highlightRanges);
        return;
      }

      right.style.display = '';
      ellipsis.style.display = '';

      const ellipsisWidth = ellipsis.offsetWidth;

      const targetWidth = Math.max(containerWidth - ellipsisWidth, 0) / 2;

      truncateTextUnderWidth(left, targetWidth, text, 'ltr');

      truncateTextUnderWidth(
        right,
        containerWidth - ellipsisWidth - left.scrollWidth,
        text,
        'rtl',
      );

      if (highlightRanges) {
        decorateHighlightedText(left, highlightRanges);
        decorateHighlightedText(
          right,
          highlightRanges,
          text.length - (right.textContent?.length ?? 0),
        );
      }
    }
  }, [text, ellipsis, highlightRanges]);

  return (
    <Container ref={containerRef} {...props}>
      <Left ref={leftRef} />
      <Ellipsis ref={ellipsisRef}>{ellipsis}</Ellipsis>
      <Right ref={rightRef} />
    </Container>
  );
};

function truncateTextUnderWidth(
  element: HTMLElement,
  width: number,
  text: string,
  direction: 'ltr' | 'rtl',
): void {
  element.textContent = text;

  if (element.scrollWidth <= width) {
    return;
  }

  let upper = text.length;
  let lower = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const length = Math.floor((upper + lower) / 2);

    element.textContent =
      direction === 'ltr' ? text.slice(0, length) : text.slice(-length);

    if (element.scrollWidth === width) {
      break;
    }

    if (element.scrollWidth < width) {
      lower = length;

      if (upper - lower <= 1) {
        break;
      }
    } else {
      upper = length;

      if (upper - lower <= 1) {
        element.textContent =
          direction === 'ltr' ? text.slice(0, lower) : text.slice(-lower);
        break;
      }
    }
  }
}
