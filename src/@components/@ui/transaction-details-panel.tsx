import {ExternalLink as externalLink} from 'lucide-react';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {AppIcon} from './app-icon.js';
import {CopyButton} from './copy-button.js';
import {EllipsisInMiddle} from './ellipsis-in-middle.js';
import {
  InfoPanel,
  InfoSection,
  InfoSectionHeader,
  InfoSectionItemLabel,
  InfoSectionRow,
} from './info-section.js';
import {inlineIconCSS, inlineIconRowCSS} from './inline-icon.js';
import {MessageSectionTags, MessageSectionTitle} from './message-content.js';

const Hash = styled(CopyButton)`
  flex: 1;
  min-width: 0;

  > :first-child {
    flex: 1;
    min-width: 0;
  }
`;

const ExplorerLink = styled.a`
  ${inlineIconRowCSS}
  font-size: 14px;
  text-decoration: none;

  > .lucide {
    ${inlineIconCSS}
    color: inherit;
  }
`;

export function TransactionDetailsPanel({
  hash,
  explorerURL,
  tags,
  children,
}: {
  hash: string;
  explorerURL?: string;
  tags?: ReactNode;
  children?: ReactNode;
}): ReactNode {
  return (
    <InfoSection>
      <InfoSectionHeader>
        <MessageSectionTags>
          <MessageSectionTitle>Details</MessageSectionTitle>
          {tags}
        </MessageSectionTags>
        {explorerURL && (
          <ExplorerLink
            href={explorerURL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View on explorer"
          >
            <AppIcon icon={externalLink} aria-hidden="true" />
          </ExplorerLink>
        )}
      </InfoSectionHeader>
      <InfoPanel role="group" aria-label="Transaction details">
        <InfoSectionRow>
          <InfoSectionItemLabel>Hash</InfoSectionItemLabel>
          <Hash value={hash} label="Copy transaction hash">
            <EllipsisInMiddle>{hash}</EllipsisInMiddle>
          </Hash>
        </InfoSectionRow>
        {children}
      </InfoPanel>
    </InfoSection>
  );
}
