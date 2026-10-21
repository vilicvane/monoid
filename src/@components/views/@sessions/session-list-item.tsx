import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {
  WalletKitSession,
  WalletKitSessionRecord,
} from '../../../@services/index.js';
import {getWalletKitSessionAddresses} from '../../../@services/index.js';
import {Address} from '../../@ui/address.js';
import {DateTime} from '../../@ui/date-time.js';
import {IndicatorDot} from '../../@ui/indicator-dot.js';
import {LIST_ICON_SIZE, ListItemName} from '../../@ui/list.js';
import {RippleEffect} from '../../@ui/ripple-effect.js';
import {SiteLogo} from '../../@ui/site-logo.js';
import {
  WalletConnectVerificationIcon,
  getWalletConnectSiteInfo,
} from '../@scan/wallet-connect-site.js';

const Item = styled.button`
  position: relative;
  display: grid;
  grid-template-columns: ${LIST_ICON_SIZE}px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--list-item-content-gap) var(--list-item-gap);
  width: 100%;
  padding: var(--list-item-padding-block, 8px)
    var(--list-item-padding-inline, var(--view-padding));
  border: none;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;

  > :first-child {
    grid-row: 1 / 3;
  }

  &:focus-visible {
    outline: 2px solid var(--ion-color-primary);
    outline-offset: -2px;
  }
`;

const Name = styled(ListItemName).attrs({as: 'div'})`
  min-width: 0;
  gap: 4px;

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .lucide {
    font-size: 16px;
  }
`;

const Activity = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--color-text-secondary);
  font-size: 12px;
  white-space: nowrap;
`;

const Accounts = styled.div`
  grid-column: 2 / -1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 18px;

  > span {
    flex-shrink: 0;
    color: var(--ion-color-primary);
  }
`;

const AccountAddress = styled(Address)`
  flex: 1;
  min-width: 0;
  font-size: inherit;
  line-height: inherit;
`;

export function SessionListItem({
  session,
  record,
  hasPendingRequest,
  onClick,
}: {
  session: WalletKitSession;
  record: WalletKitSessionRecord;
  hasPendingRequest: boolean;
  onClick: () => void;
}): ReactNode {
  const {metadata} = session.peer;
  const info = getWalletConnectSiteInfo({metadata, verified: record.verified});
  const addresses = getWalletKitSessionAddresses(session);

  return (
    <Item
      type="button"
      className="ion-activatable"
      aria-label={`View session with ${info.name}${hasPendingRequest ? ', pending request' : ''}`}
      onClick={onClick}
    >
      <SiteLogo
        name={info.name}
        url={metadata.url}
        icons={metadata.icons}
        size={LIST_ICON_SIZE}
      />
      <Name>
        <span title={info.name}>{info.name}</span>
        <WalletConnectVerificationIcon info={info} />
      </Name>
      <Activity aria-label="Last active">
        {hasPendingRequest && (
          <IndicatorDot aria-hidden="true" title="Pending request" />
        )}
        <DateTime value={record.lastActivityAt} compact />
      </Activity>
      {!!addresses.length && (
        <Accounts>
          <AccountAddress title={addresses[0]}>{addresses[0]!}</AccountAddress>
          {addresses.length > 1 && (
            <span title={`${addresses.length - 1} more accounts`}>
              +{addresses.length - 1}
            </span>
          )}
        </Accounts>
      )}
      <RippleEffect />
    </Item>
  );
}
