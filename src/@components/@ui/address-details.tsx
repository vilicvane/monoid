import {getAddress} from 'ethers';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import {useEntrances} from '../../@entrances.js';
import type {AddressKind} from '../../@lib/address-status.js';
import type {AddressMark} from '../../@services/index.js';
import {KeyDerivationTag, KeyTags} from '../@key/key-tags.js';

import {getAddressMarkerLabel} from './address-marker.js';
import {CenteredPopup} from './centered-popup.js';
import {
  InfoSection,
  InfoSectionItemLabel,
  InfoSectionRow,
} from './info-section.js';
import {PopupAddress} from './popup-address.js';
import {SegmentedControl} from './segmented-control.js';

export const AddressDetails = observer(function AddressDetails({
  address,
  kind,
  onDismiss,
}: {
  address: string;
  kind: AddressKind;
  onDismiss: () => void;
}): ReactNode {
  const {addressBookService, errorService} = useEntrances();
  const mark = addressBookService.getMark('evm', address);

  return (
    <CenteredPopup aria-label="Address details" onDismiss={onDismiss}>
      <KeyTags>
        <KeyDerivationTag chain="evm">EVM</KeyDerivationTag>
      </KeyTags>
      <PopupAddress>{getAddress(address)}</PopupAddress>
      <InfoSection>
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
      </InfoSection>
      <SegmentedControl<AddressMark | 'none'>
        aria-label="Address mark"
        value={mark ?? 'none'}
        options={[
          {value: 'none', label: 'Unknown'},
          {value: 'trusted', label: 'Trusted', color: 'safe'},
          {value: 'dangerous', label: 'Dangerous', color: 'danger'},
        ]}
        onChange={errorService.catch(async (value: AddressMark | 'none') => {
          await addressBookService.setMark(
            'evm',
            address,
            value === 'none' ? undefined : value,
          );
        })}
      />
    </CenteredPopup>
  );
});
