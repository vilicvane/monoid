import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import {useEntrances} from '../../@entrances.js';
import type {AddressMark} from '../../@services/index.js';

import {SegmentedControl} from './segmented-control.js';

export const AddressMarkControl = observer(function AddressMarkControl({
  address,
}: {
  address: string;
}): ReactNode {
  const {addressBookService, errorService} = useEntrances();

  return (
    <SegmentedControl<AddressMark | 'none'>
      aria-label="Address mark"
      value={addressBookService.getMark('evm', address) ?? 'none'}
      options={[
        {value: 'none', label: 'Default'},
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
  );
});
