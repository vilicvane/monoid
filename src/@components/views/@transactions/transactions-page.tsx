import type {ReactNode} from 'react';

import type {AddressType} from '../../../@lib/wallet-address.js';
import type {WalletKeyData} from '../../../@services/index.js';
import {WalletAccountList} from '../../@key/wallet-account-list.js';
import {InfoSection, InfoSectionItemLabel} from '../../@ui/info-section.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  ViewLoading,
  ViewPlaceholder,
} from '../../@view/index.js';
import {TransactionList} from '../@sessions/transaction-list.js';

export function TransactionsPage({
  active,
  keys,
  account,
  unavailableMessage,
  hasTransactions,
  loading = false,
  emptyMessage = 'No transactions',
  beforeList,
  afterList,
  children,
}: {
  active: boolean;
  keys: readonly WalletKeyData[];
  account: {address: string; addressType: AddressType} | undefined;
  unavailableMessage?: string;
  hasTransactions: boolean;
  loading?: boolean;
  emptyMessage?: string | null;
  beforeList?: ReactNode;
  afterList?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <View inert={!active}>
      <ViewHeader>
        <ViewHeaderTitle>Transactions</ViewHeaderTitle>
      </ViewHeader>
      <ViewContent>
        {!account ? (
          <ViewPlaceholder>{unavailableMessage}</ViewPlaceholder>
        ) : (
          <>
            <InfoSection>
              <WalletAccountList
                keys={keys}
                addressType={account.addressType}
                addresses={[account.address]}
                compact
                contained
              />
            </InfoSection>
            {hasTransactions && (
              <InfoSectionItemLabel>Choose transaction</InfoSectionItemLabel>
            )}
            {beforeList}
            {hasTransactions ? (
              <TransactionList>{children}</TransactionList>
            ) : loading ? (
              <ViewLoading />
            ) : emptyMessage ? (
              <ViewPlaceholder>{emptyMessage}</ViewPlaceholder>
            ) : null}
            {afterList}
          </>
        )}
      </ViewContent>
    </View>
  );
}
