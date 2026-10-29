import {UserRound, Wallet} from 'lucide-react';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {AuthorityAccount} from '../../@lib/authority-client.js';

import {Address} from './address.js';
import {AppIcon} from './app-icon.js';
import {InfoFieldset, InfoLegend} from './info-section.js';
import {
  ListItem,
  ListItemContent,
  ListItemDescription,
  ListItemName,
} from './list.js';
import {Symbol} from './symbol.js';

const SOURCE_NAMES = {
  google: 'Google',
  'github-user': 'GitHub',
  wallet: 'Wallet',
};

// Card Applets' row geometry, inside an InfoFieldset instead of an IconList.
const AccountRow = styled(ListItem)`
  --list-item-gap: 12px;
  --list-item-content-gap: 2px;
  --list-item-name-line-height: 20px;
  --list-item-padding-block: 0px;
  --list-item-padding-inline: 0px;
  align-items: center;

  ${ListItemName} {
    min-width: 0;
    overflow-wrap: anywhere;
    text-wrap: pretty;
  }

  ${Address} {
    width: 100%;
  }
`;

export function AuthorityAccountInfo({
  account,
}: {
  account: AuthorityAccount;
}): ReactNode {
  const description = SOURCE_NAMES[account.source];
  const icon = account.source === 'wallet' ? Wallet : UserRound;

  return (
    <InfoFieldset>
      <InfoLegend>Signed in as</InfoLegend>
      <AccountRow>
        <Symbol>
          <AppIcon icon={icon} aria-hidden="true" />
        </Symbol>
        <ListItemContent>
          <ListItemName>
            {account.source === 'wallet' ? (
              <Address
                title={account.displayName}
                aria-label={account.displayName}
              >
                {account.displayName}
              </Address>
            ) : (
              account.displayName
            )}
          </ListItemName>
          <ListItemDescription>{description}</ListItemDescription>
        </ListItemContent>
      </AccountRow>
    </InfoFieldset>
  );
}
