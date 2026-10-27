import {ArrowLeftRight, Mail, UserRound, Wallet} from 'lucide-react';
import {styled} from 'styled-components';
import type {SocialProvider} from '../../src/domain.js';
import {Address} from '../../../../src/@components/@ui/address.js';
import {AppIcon} from '../../../../src/@components/@ui/app-icon.js';
import {IconButton} from '../../../../src/@components/@ui/icon-button.js';
import {
  InfoFieldset,
  InfoLegend,
} from '../../../../src/@components/@ui/info-section.js';
import {
  LIST_ICON_SIZE,
  ListItem,
  ListItemContent,
  ListItemName,
  ListItemDescription,
} from '../../../../src/@components/@ui/list.js';
import type {Identity} from './reown.js';

export const PROVIDER_NAMES: Record<SocialProvider, string> = {
  google: 'Google',
  x: 'X',
  github: 'GitHub',
  discord: 'Discord',
  apple: 'Apple',
  facebook: 'Facebook',
  farcaster: 'Farcaster',
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

// Symbol is private to card-management-content.tsx; keep this copy identical.
const Symbol = styled.span`
  width: ${LIST_ICON_SIZE}px;
  height: ${LIST_ICON_SIZE}px;
  border-radius: ${LIST_ICON_SIZE / 4}px;
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 28px;
`;

export function AccountCard({
  account,
  busy,
  onChange,
}: {
  account: Identity;
  busy: boolean;
  onChange: () => void;
}) {
  const description =
    account.method === 'social'
      ? PROVIDER_NAMES[account.provider!]
      : account.method === 'wallet'
        ? 'Wallet'
        : 'Email';
  const icon =
    account.method === 'wallet'
      ? Wallet
      : account.method === 'social'
        ? UserRound
        : Mail;
  const name =
    account.email ||
    (account.method === 'social' ? `${description} account` : 'Signed in.');

  return (
    <InfoFieldset>
      <InfoLegend>Signed in as</InfoLegend>
      <AccountRow>
        <Symbol>
          <AppIcon icon={icon} aria-hidden="true" />
        </Symbol>
        <ListItemContent>
          <ListItemName>
            {account.method === 'wallet' ? (
              <Address title={account.login} aria-label={account.login}>
                {account.login}
              </Address>
            ) : (
              name
            )}
          </ListItemName>
          <ListItemDescription>{description}</ListItemDescription>
        </ListItemContent>
        <IconButton
          aria-label="Use another account"
          disabled={busy}
          onClick={onChange}
        >
          <AppIcon icon={ArrowLeftRight} aria-hidden="true" />
        </IconButton>
      </AccountRow>
    </InfoFieldset>
  );
}
