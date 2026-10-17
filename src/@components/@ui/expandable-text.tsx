import {type ReactNode, useState} from 'react';
import {styled} from 'styled-components';

const Content = styled.button<{$expanded: boolean; $lines: number}>`
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: ${({$expanded, $lines}) =>
    $expanded ? 'unset' : $lines};
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  overflow: hidden;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  white-space: inherit;
  overflow-wrap: anywhere;
  user-select: text;
`;

export function ExpandableText({
  children,
  lines = 4,
}: {
  children: string;
  lines?: number;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);

  return (
    <Content
      type="button"
      $expanded={expanded}
      $lines={lines}
      aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}
    >
      {children}
    </Content>
  );
}
