import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {
  WalletKitSession,
  WalletKitSessionRecord,
} from '../../../@services/index.js';
import {getWalletKitSessionAddresses} from '../../../@services/index.js';
import {Address} from '../../@ui/address.js';
import {DateTime} from '../../@ui/date-time.js';
import {RippleEffect} from '../../@ui/ripple-effect.js';
import {SiteLogo} from '../../@ui/site-logo.js';
import {
  WalletConnectVerificationIcon,
  getWalletConnectSiteInfo,
} from '../@scan/wallet-connect-site.js';

export const SessionList = styled.div`
  margin: 0 calc(-1 * var(--view-padding));
`;

const Item = styled.button`
  position: relative;
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: center;
  gap: 2px 12px;
  width: 100%;
  padding: 12px var(--view-padding);
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

const Name = styled.div`
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 6px;
  font-size: 16px;
  line-height: 20px;

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  ion-icon {
    font-size: 16px;
  }
`;

const Activity = styled.div`
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
  onClick,
}: {
  session: WalletKitSession;
  record: WalletKitSessionRecord;
  onClick: () => void;
}): ReactNode {
  const {metadata} = session.peer;
  const info = getWalletConnectSiteInfo({metadata, verified: record.verified});
  const addresses = getWalletKitSessionAddresses(session);

  return (
    <Item
      type="button"
      className="ion-activatable"
      aria-label={`View session with ${info.name}`}
      onClick={onClick}
    >
      <SiteLogo
        name={info.name}
        url={metadata.url}
        icons={metadata.icons}
        size={36}
      />
      <Name>
        <span title={info.name}>{info.name}</span>
        <WalletConnectVerificationIcon info={info} />
      </Name>
      <Activity aria-label="Last active">
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
