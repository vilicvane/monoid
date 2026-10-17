import type {ReactNode} from 'react';

export type HighlightRange = readonly [start: number, end: number];

const emphasisColor = 'var(--color-text-emphasis, currentColor)';

function getSegments(
  text: string,
  ranges: readonly HighlightRange[],
  offset = 0,
): {text: string; start: number; highlighted: boolean}[] {
  const segments: {text: string; start: number; highlighted: boolean}[] = [];
  let cursor = 0;

  for (const [rangeStart, rangeEnd] of ranges) {
    const start = Math.max(cursor, rangeStart - offset);
    const end = Math.min(text.length, rangeEnd - offset);
    if (start >= end) continue;

    if (cursor < start) {
      segments.push({
        text: text.slice(cursor, start),
        start: cursor,
        highlighted: false,
      });
    }

    segments.push({text: text.slice(start, end), start, highlighted: true});
    cursor = end;
  }

  if (cursor < text.length) {
    segments.push({
      text: text.slice(cursor),
      start: cursor,
      highlighted: false,
    });
  }

  return segments;
}

export function HighlightedText({
  children: text,
  ranges,
}: {
  children: string;
  ranges?: readonly HighlightRange[];
}): ReactNode {
  if (!ranges) return text;

  return getSegments(text, ranges).map(segment =>
    segment.highlighted ? (
      <span key={segment.start} style={{color: emphasisColor}}>
        {segment.text}
      </span>
    ) : (
      segment.text
    ),
  );
}

export function decorateHighlightedText(
  element: HTMLElement,
  ranges: readonly HighlightRange[],
  offset = 0,
): void {
  const document = element.ownerDocument;
  const nodes = getSegments(element.textContent ?? '', ranges, offset).map(
    segment => {
      if (!segment.highlighted) return document.createTextNode(segment.text);

      const span = document.createElement('span');
      span.style.color = emphasisColor;
      span.textContent = segment.text;
      return span;
    },
  );

  element.replaceChildren(...nodes);
}
