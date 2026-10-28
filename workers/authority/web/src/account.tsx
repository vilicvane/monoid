import {ArrowLeftRight, UserRound, Wallet} from 'lucide-react';
import {styled} from 'styled-components';
import type {Account} from '../../src/domain.js';
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

export const SOURCE_NAMES = {
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
  account: Account;
  busy: boolean;
  onChange: () => void;
}) {
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
