import {CircleAlert as circleAlert} from 'lucide-react';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {CardItemIssue} from '../../@lib/monoid/index.js';
import {KeyList} from '../@key/key-list.js';
import {AppIcon} from '../@ui/app-icon.js';
import {
  ListItem,
  ListItemContent,
  ListItemDescription,
  ListItemName,
  ListSectionTitle,
} from '../@ui/list.js';

const REASONS: Record<string, string> = {
  Conflict: 'Different item already on card',
  Unreadable: 'Unreadable record',
  INVALID_PARAMETER: 'Not accepted by this card',
  NOT_FOUND: 'Missing on card',
  UNSUPPORTED_CURVE: 'Not supported by this card',
  UNSUPPORTED_SEED_LENGTH: 'Not supported by this card',
};

const Section = styled.section`
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const IssueIcon = styled(AppIcon)`
  flex-shrink: 0;
  font-size: 20px;
  color: var(--ion-color-warning-shade);
`;

const Index = styled(ListItemName)`
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
`;

/** Per-item problems that did not stop the rest of the operation. */
export function CardItemIssues({
  title,
  issues,
  contained = false,
}: {
  title: string;
  issues: readonly CardItemIssue[];
  contained?: boolean;
}): ReactNode {
  return (
    <Section>
      <ListSectionTitle>{title}</ListSectionTitle>
      <KeyList $contained={contained}>
        {issues.map(issue => (
          <ListItem key={issue.index}>
            <IssueIcon icon={circleAlert} aria-hidden="true" />
            <ListItemContent>
              <Index>{issue.index}</Index>
              <ListItemDescription>
                {REASONS[issue.reason] ?? issue.reason}
              </ListItemDescription>
            </ListItemContent>
          </ListItem>
        ))}
      </KeyList>
    </Section>
  );
}
