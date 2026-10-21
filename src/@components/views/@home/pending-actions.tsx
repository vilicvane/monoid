import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {
  type PendingAction,
  getPendingActionExpiry,
  getPendingActionTitle,
} from '../../../@lib/pending-action.js';
import {InfoSection, InfoSectionHeader} from '../../@ui/info-section.js';
import {ListSectionCount} from '../../@ui/list-section.js';
import {
  IconList,
  LIST_ICON_SIZE,
  ListItemButton,
  ListItemContent,
  ListItemDescription,
  ListItemName,
  ListSectionTitle,
} from '../../@ui/list.js';
import {RemainingTime} from '../../@ui/remaining-time.js';
import {RippleEffect} from '../../@ui/ripple-effect.js';
import {SiteLogo} from '../../@ui/site-logo.js';
import {
  WalletConnectVerificationIcon,
  getWalletConnectSiteInfo,
} from '../@scan/wallet-connect-site.js';

const Section = styled(InfoSection)`
  margin-inline: 2px;
`;

const ActionList = styled(IconList)`
  > button > time {
    align-self: flex-start;
    margin-top: 1px;
    margin-right: 1px;
  }
`;

const Source = styled.span`
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;

  .lucide {
    font-size: 16px;
  }
`;

export function PendingActions({
  actions,
  onSelect,
}: {
  actions: readonly PendingAction[];
  onSelect: (action: PendingAction) => void;
}): ReactNode {
  if (!actions.length) return null;

  return (
    <Section as="section" aria-label="Actions required">
      <InfoSectionHeader>
        <ListSectionTitle>Actions required</ListSectionTitle>
        <ListSectionCount aria-label={`${actions.length} actions remaining`}>
          {actions.length}
        </ListSectionCount>
      </InfoSectionHeader>
      <ActionList>
        {actions.map(action => {
          const {request, session} = action;
          const {metadata} = session.peer;
          const info = getWalletConnectSiteInfo({
            metadata,
            verified: request.verifyContext.verified,
          });
          const title = getPendingActionTitle(action);
          const expiry = getPendingActionExpiry(action);

          return (
            <ListItemButton
              key={action.id}
              type="button"
              className="ion-activatable"
              aria-label={`${title} from ${info.name}`}
              onClick={() => onSelect(action)}
            >
              <SiteLogo
                name={info.name}
                url={metadata.url}
                icons={metadata.icons}
                size={LIST_ICON_SIZE}
              />
              <ListItemContent as="span">
                <ListItemName>{title}</ListItemName>
                <Source>
                  <ListItemDescription title={info.name}>
                    {info.name}
                  </ListItemDescription>
                  <WalletConnectVerificationIcon info={info} />
                </Source>
              </ListItemContent>
              <RemainingTime value={expiry} />
              <RippleEffect />
            </ListItemButton>
          );
        })}
      </ActionList>
    </Section>
  );
}
