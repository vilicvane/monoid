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
import {CenteredPopupAddress} from './popup-address.js';

export function AddressDetails({
  address,
  kind,
  onDismiss,
}: {
  address: string;
  kind: AddressKind;
  onDismiss: () => void;
}): ReactNode {
  return (
    <DetailsPopup aria-label="Address details" onDismiss={onDismiss}>
      <AddressDetailsContent address={address} kind={kind} />
    </DetailsPopup>
  );
}

export const AddressDetailsContent = observer(function AddressDetailsContent({
  address,
  kind,
}: {
  address: string;
  kind: AddressKind;
}): ReactNode {
  const {addressBookService} = useEntrances();

  return (
    <>
      <DetailsPopupHeader>
        <KeyDerivationTag chain="evm">EVM</KeyDerivationTag>
      </DetailsPopupHeader>
      <CenteredPopupAddress highlightEdges>
        {getAddress(address)}
      </CenteredPopupAddress>
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
    </>
  );
});
