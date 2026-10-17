import {getAddress} from 'ethers';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import {useEntrances} from '../../@entrances.js';
import type {AddressKind} from '../../@lib/address-status.js';
import {KeyDerivationTag} from '../@key/key-tags.js';

import {AddressMarkControl} from './address-mark-control.js';
import {getAddressMarkerLabel} from './address-marker.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupHeader,
  DetailsPopupSection,
} from './details-popup.js';
import {InfoSectionItemLabel, InfoSectionRow} from './info-section.js';
import {PopupAddress} from './popup-address.js';

export const AddressDetails = observer(function AddressDetails({
  address,
  kind,
  onDismiss,
}: {
  address: string;
  kind: AddressKind;
  onDismiss: () => void;
}): ReactNode {
  const {addressBookService} = useEntrances();

  return (
    <DetailsPopup aria-label="Address details" onDismiss={onDismiss}>
      <DetailsPopupHeader>
        <KeyDerivationTag chain="evm">EVM</KeyDerivationTag>
      </DetailsPopupHeader>
      <PopupAddress>{getAddress(address)}</PopupAddress>
      <DetailsPopupDivider />
      <DetailsPopupSection>
        <InfoSectionRow>
          <InfoSectionItemLabel>Identity</InfoSectionItemLabel>
          <span>{getAddressMarkerLabel(kind)}</span>
        </InfoSectionRow>
        <InfoSectionRow>
          <InfoSectionItemLabel>Seen in signed messages</InfoSectionItemLabel>
          <span>
            {addressBookService.hasSigned('evm', address) ? 'Yes' : 'No'}
          </span>
        </InfoSectionRow>
      </DetailsPopupSection>
      <AddressMarkControl address={address} />
    </DetailsPopup>
  );
});
