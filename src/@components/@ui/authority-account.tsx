import {
  Mail as mail,
  UserRound as userRound,
  Wallet as wallet,
} from 'lucide-react';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {AuthorityAccount} from '../../@lib/authority-client.js';

import {Address} from './address.js';
import {AppIcon} from './app-icon.js';
import {InfoFieldset, InfoLegend} from './info-section.js';
import {
  IconList,
  ListItem,
  ListItemContent,
  ListItemDescription,
  ListItemName,
} from './list.js';
import {Symbol} from './symbol.js';

const PROVIDER_NAMES: Record<string, string> = {
  google: 'Google',
  github: 'GitHub',
  apple: 'Apple',
  facebook: 'Facebook',
  x: 'X',
  discord: 'Discord',
  farcaster: 'Farcaster',
};

const Account = styled(IconList)`
  --list-item-padding-inline: 0px;
  --list-item-padding-block: 0px;
  flex: none;
  margin: 0;
`;

const AccountRow = styled(ListItem)`
  align-items: center;
`;

const AccountName = styled(ListItemName)`
  overflow-wrap: anywhere;

  ${Address} {
    width: 100%;
  }
`;

export function AuthorityAccountInfo({
  account,
}: {
  account: Pick<AuthorityAccount, 'method' | 'login' | 'email' | 'provider'>;
}): ReactNode {
  const description =
    account.method === 'wallet'
      ? 'Wallet'
      : account.method === 'email'
        ? 'Email'
        : (PROVIDER_NAMES[account.provider ?? ''] ??
          account.provider ??
          'Social');

  return (
    <InfoFieldset>
      <InfoLegend>Signed in as</InfoLegend>
      <Account>
        <AccountRow>
          <Symbol>
            <AppIcon
              icon={
                account.method === 'wallet'
                  ? wallet
                  : account.method === 'email'
                    ? mail
                    : userRound
              }
              aria-hidden="true"
            />
          </Symbol>
          <ListItemContent>
            <AccountName>
              {account.method === 'wallet' ? (
                <Address title={account.login} aria-label={account.login}>
                  {account.login}
                </Address>
              ) : (
                account.email ||
                (account.method === 'social'
                  ? `${description} account`
                  : 'Signed in.')
              )}
            </AccountName>
            <ListItemDescription>{description}</ListItemDescription>
          </ListItemContent>
        </AccountRow>
      </Account>
    </InfoFieldset>
  );
}
