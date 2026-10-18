import {Signature as signature} from 'lucide-react';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {
  type PendingAction,
  getPendingActionExpiry,
  getPendingActionTitle,
} from '../../../@lib/pending-action.js';
import {AppIcon} from '../../@ui/app-icon.js';
import {InfoSection, InfoSectionHeader} from '../../@ui/info-section.js';
import {ListSectionCount} from '../../@ui/list-section.js';
import {
  List,
  ListItemButton,
  ListItemName,
  ListSectionTitle,
} from '../../@ui/list.js';
import {RemainingTime} from '../../@ui/remaining-time.js';
import {RippleEffect} from '../../@ui/ripple-effect.js';

const RequestIcon = styled(AppIcon)`
  flex-shrink: 0;
  font-size: 18px;
  color: var(--ion-color-primary);
`;

const RequestList = styled(List)`
  --list-item-padding-block: 12px;
  --list-item-gap: 12px;
  --list-item-name-line-height: 20px;

  time {
    margin-right: 1px;
  }
`;

export function PendingRequests({
  actions,
  onSelect,
}: {
  actions: readonly PendingAction[];
  onSelect: (action: PendingAction) => void;
}): ReactNode {
  if (!actions.length) return null;

  return (
    <InfoSection as="section" aria-label="Pending requests">
      <InfoSectionHeader>
        <ListSectionTitle>Pending requests</ListSectionTitle>
        <ListSectionCount aria-label={`${actions.length} requests remaining`}>
          {actions.length}
        </ListSectionCount>
      </InfoSectionHeader>
      <RequestList>
        {actions.map(action => (
          <ListItemButton
            key={action.id}
            type="button"
            className="ion-activatable"
            onClick={() => onSelect(action)}
          >
            <ListItemName>
              <RequestIcon icon={signature} aria-hidden="true" />
              {getPendingActionTitle(action)}
            </ListItemName>
            <RemainingTime value={getPendingActionExpiry(action)} />
            <RippleEffect />
          </ListItemButton>
        ))}
      </RequestList>
    </InfoSection>
  );
}
