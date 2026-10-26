import {TriangleAlert as triangleAlert} from 'lucide-react';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {SafeIndexHex} from '../../../../@atomics.js';
import type {CardItemIssue} from '../../../../@lib/monoid/index.js';
import {AppIcon} from '../../../@ui/app-icon.js';

import {CardResourceItem, CardResourceList} from './@resource-item.js';

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

/** A rule with the reason in its middle, so the group reads as a tail of the list. */
const Separator = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  line-height: 20px;

  &::before,
  &::after {
    content: '';
    flex: 1;
    border-top: solid 0.5px var(--color-text-secondary);
    opacity: 0.5;
  }
`;

const Label = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 6px;

  > svg {
    color: var(--color-text-warning);
  }
`;

/** Skipped items retain the same tags and identifiers as card resource lists. */
export function CardResourceIssues({
  issues,
  items = [],
}: {
  issues: readonly CardItemIssue[];
  items?: readonly {index: string; alias?: string}[];
}): ReactNode {
  const groups = new Map<string, CardItemIssue[]>();
  const aliases = new Map(items.map(item => [item.index, item.alias]));

  for (const issue of issues) {
    const reason = REASONS[issue.reason] ?? issue.reason;
    const group = groups.get(reason);

    if (group) group.push(issue);
    else groups.set(reason, [issue]);
  }

  return [...groups].map(([reason, group]) => (
    <Section key={reason}>
      <Separator role="separator">
        <Label>
          <AppIcon icon={triangleAlert} />
          {reason}
        </Label>
      </Separator>
      <CardResourceList $contained>
        {group.map(issue => (
          <CardResourceItem
            key={issue.index}
            data={{
              index: SafeIndexHex.satisfies(issue.index),
              alias: aliases.get(issue.index),
            }}
          />
        ))}
      </CardResourceList>
    </Section>
  ));
}
