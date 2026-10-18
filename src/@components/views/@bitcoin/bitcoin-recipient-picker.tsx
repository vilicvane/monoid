import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../@entrances.js';
import {BITCOIN_ADDRESS_TYPES} from '../../../@lib/bitcoin-wallet.js';
import {KeyListAddress} from '../../@key/key-list.js';
import {WalletAccountList} from '../../@key/wallet-account-list.js';
import {Button} from '../../@ui/button.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from '../../@ui/details-popup.js';
import {InfoSection, InfoSectionItemLabel} from '../../@ui/info-section.js';
import {List, ListItem, ListItemButton} from '../../@ui/list.js';
import {RippleEffect} from '../../@ui/ripple-effect.js';

import {getBitcoinRecipients} from './bitcoin-recipients.js';

const Accounts = styled(InfoSection)`
  container-type: inline-size;
  --ion-color-dark: white;
  --ion-color-medium: var(--color-text-label);
  --view-padding: calc((100vw - 100cqw) / 2);
  --list-item-padding-inline: var(--view-padding);
  --recipient-safe-offset: calc(
    (var(--view-inset-left) - var(--view-inset-right)) / 2
  );

  ${List} {
    margin-left: calc(-1 * var(--view-padding) - var(--recipient-safe-offset));
    margin-right: calc(-1 * var(--view-padding) + var(--recipient-safe-offset));
  }

  ${ListItem}, ${ListItemButton} {
    padding-left: calc(var(--view-padding) + var(--recipient-safe-offset));
    padding-right: calc(var(--view-padding) - var(--recipient-safe-offset));
  }
`;

export const BitcoinRecipientPicker = observer(function BitcoinRecipientPicker({
  address,
  onSelect,
  onDismiss,
}: {
  address: string;
  onSelect: (address: string) => void;
  onDismiss: () => void;
}): ReactNode {
  const {walletStorageService, bitcoinWalletService} = useEntrances();
  const {recent} = getBitcoinRecipients(
    walletStorageService.keys,
    bitcoinWalletService.getSubmissions(address),
  );

  return (
    <DetailsPopup aria-label="Choose address" onDismiss={onDismiss}>
      <DetailsPopupTitle>Choose address</DetailsPopupTitle>
      <DetailsPopupDivider />
      <Accounts>
        <WalletAccountList
          keys={walletStorageService.keys}
          addressType={BITCOIN_ADDRESS_TYPES}
          onOpen={onSelect}
        />
      </Accounts>
      {recent.length > 0 && (
        <Accounts>
          <InfoSectionItemLabel>Recent</InfoSectionItemLabel>
          <List>
            {recent.map(recipient => (
              <ListItemButton
                key={recipient}
                type="button"
                className="ion-activatable"
                onClick={() => onSelect(recipient)}
              >
                <KeyListAddress>{recipient}</KeyListAddress>
                <RippleEffect />
              </ListItemButton>
            ))}
          </List>
        </Accounts>
      )}
      <Button color="neutral" onClick={onDismiss}>
        Cancel
      </Button>
    </DetailsPopup>
  );
});
