import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {ExpandableAddress} from './expandable-address.js';
import {MessageContent} from './message-content.js';

const Address = styled(MessageContent)`
  --color-text-emphasis: white;

  margin: 0;
  padding: 0;
  background: transparent;
  color: rgba(255, 255, 255, 0.65);

  &[aria-expanded='true'] {
    color: var(--color-text-emphasis);
  }
`;

export function PopupAddress({
  children,
  className,
}: {
  children: string;
  className?: string;
}): ReactNode {
  return (
    <Address as={ExpandableAddress} highlightEdges className={className}>
      {children}
    </Address>
  );
}
