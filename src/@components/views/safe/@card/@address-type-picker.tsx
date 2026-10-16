import {type ReactNode, useState} from 'react';
import {styled} from 'styled-components';

import type {AddressType} from '../../../../@lib/wallet-address.js';
import {AddressTypeSelector} from '../../../@key/address-type-selector.js';
import {Button} from '../../../@ui/button.js';
import {CenteredPopup} from '../../../@ui/centered-popup.js';

const Picker = styled(CenteredPopup)`
  --address-selector-gap: 16px;
`;

export const AddressTypePicker = ({
  value,
  addressTypes,
  onChange,
  onDismiss,
}: {
  value: AddressType;
  addressTypes: readonly AddressType[];
  onChange: (value: AddressType) => void;
  onDismiss: () => void;
}): ReactNode => {
  const [draft, setDraft] = useState(value);

  return (
    <Picker aria-label="Address type" onDismiss={onDismiss}>
      <AddressTypeSelector
        value={draft}
        onChange={setDraft}
        addressTypes={addressTypes}
      />
      <Button type="button" onClick={() => onChange(draft)}>
        Done
      </Button>
    </Picker>
  );
};
