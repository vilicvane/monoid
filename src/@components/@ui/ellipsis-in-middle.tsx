import type {HTMLProps, ReactNode} from 'react';
import {useLayoutEffect, useRef} from 'react';
import {styled} from 'styled-components';

const Container = styled.div`
  display: flex;
  justify-content: space-between;
  overflow: hidden;
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
  ...props
}: {
  children: string;
  ellipsis?: string;
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
    }
  }, [text]);

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
