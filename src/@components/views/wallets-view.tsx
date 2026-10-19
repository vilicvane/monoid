import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {
  type AddressType,
  normalizeWalletAddress,
} from '../../@lib/wallet-address.js';
import type {WalletKeyData} from '../../@services/index.js';
import {WalletAccountList} from '../@key/wallet-account-list.js';
import {LoadingSpinner} from '../@ui/loading-spinner.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../@view/index.js';

const PendingTransactions = styled.span`
  display: inline-flex;
  align-items: center;
  align-self: center;
  flex-shrink: 0;
  order: 2;
  margin-left: auto;
  font-size: 16px;
  color: var(--ion-color-primary);
`;

export const WalletsView = ({
  title,
  active,
  keys,
  addressType,
  pendingCounts,
  onOpen,
  children,
}: {
  title: string;
  active: boolean;
  keys: readonly WalletKeyData[];
  addressType: AddressType | readonly AddressType[];
  pendingCounts?: ReadonlyMap<string, number>;
  onOpen: (address: string) => void;
  children?: ReactNode;
}): ReactNode => (
  <View inert={!active}>
    {children}
    <ViewHeader>
      <ViewHeaderTitle>{title}</ViewHeaderTitle>
    </ViewHeader>
    <ViewContent>
      <WalletAccountList
        selectionLabel="Choose wallet"
        keys={keys}
        addressType={addressType}
        renderStatus={
          pendingCounts &&
          (addresses => {
            const count = addresses.reduce(
              (sum, address) =>
                sum + (pendingCounts.get(normalizeWalletAddress(address)) ?? 0),
              0,
            );
            if (!count) return null;

            const label = `${count} pending transaction${count === 1 ? '' : 's'}`;
            return (
              <PendingTransactions
                role="status"
                aria-label={label}
                title={label}
              >
                <LoadingSpinner />
              </PendingTransactions>
            );
          })
        }
        onOpen={onOpen}
      />
    </ViewContent>
  </View>
);
