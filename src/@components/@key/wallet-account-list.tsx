import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import type {
  WalletKeyData,
  WalletKeyWalletData,
} from '../../@services/index.js';
import {getKeyWallets} from '../../@services/index.js';

import {ExpandableKeyGroup, KeyGroupItem} from './expandable-key-group.js';
import {KeyCheckbox} from './key-checkbox.js';
import {
  KeyList,
  KeyListAddress,
  KeyListItem,
  KeyListItemContent,
  KeyListPlaceholder,
} from './key-list.js';
import {
  KeyAliasTag,
  KeyDerivationTag,
  KeyTags,
  KeyTypeTag,
} from './key-tags.js';

type AccountGroup = {key: WalletKeyData; wallets: WalletKeyWalletData[]};
type SelectionProps = {
  selectedAddresses: ReadonlySet<string>;
  onToggle: (address: string) => void;
  disabled?: boolean;
};

const WalletAccountGroup = observer(function WalletAccountGroup({
  group: {key, wallets},
  selectedAddresses,
  onToggle,
  disabled,
}: SelectionProps & {group: AccountGroup}): ReactNode {
  return (
    <ExpandableKeyGroup>
      {({expanded, revealing, expand}) => {
        const collapsed = wallets.length > 1 && !expanded;

        return (collapsed ? wallets.slice(0, 1) : wallets).map(
          (wallet, index) => (
            <KeyGroupItem
              as="label"
              key={wallet.address.toLowerCase()}
              $revealing={revealing && index > 0}
              disabled={collapsed ? disabled : undefined}
              aria-expanded={collapsed ? false : undefined}
              aria-label={
                collapsed
                  ? `Show ${wallets.length} accounts for ${key.alias || key.type}`
                  : undefined
              }
              onExpand={collapsed ? expand : undefined}
            >
              <KeyListItemContent>
                <KeyTags>
                  <KeyCheckbox
                    count={collapsed ? wallets.length : undefined}
                    aria-label={`Select ${wallet.address}`}
                    checked={selectedAddresses.has(
                      wallet.address.toLowerCase(),
                    )}
                    onChange={() => onToggle(wallet.address)}
                    disabled={disabled}
                  />
                  <KeyTypeTag className={key.type}>{key.type}</KeyTypeTag>
                  {key.alias && <KeyAliasTag>{key.alias}</KeyAliasTag>}
                  {wallet.path && (
                    <KeyDerivationTag chain="evm">
                      {wallet.path}
                    </KeyDerivationTag>
                  )}
                </KeyTags>
                <KeyListAddress>{wallet.address}</KeyListAddress>
              </KeyListItemContent>
            </KeyGroupItem>
          ),
        );
      }}
    </ExpandableKeyGroup>
  );
});

export const WalletAccountList = observer(
  ({
    keys,
    addressType,
    selectedAddresses,
    onToggle,
    disabled = false,
  }: {
    keys: readonly WalletKeyData[];
    addressType: 'evm';
  } & SelectionProps): ReactNode => {
    const groups = new Map<WalletKeyData['index'], AccountGroup>();
    const addresses = new Set<string>();
    const selected = new Set(
      Array.from(selectedAddresses, address => address.toLowerCase()),
    );

    for (const key of keys) {
      for (const wallet of getKeyWallets(key)) {
        if (wallet.addressType !== addressType) continue;

        const address = wallet.address.toLowerCase();
        if (addresses.has(address)) continue;

        addresses.add(address);
        let group = groups.get(key.index);
        if (!group) {
          group = {key, wallets: []};
          groups.set(key.index, group);
        }
        group.wallets.push(wallet);
      }
    }

    return (
      <KeyList>
        {groups.size ? (
          Array.from(groups, ([index, group]) => (
            <WalletAccountGroup
              key={index}
              group={group}
              selectedAddresses={selected}
              onToggle={onToggle}
              disabled={disabled}
            />
          ))
        ) : (
          <KeyListItem>
            <KeyListPlaceholder>No EVM accounts in Safe.</KeyListPlaceholder>
          </KeyListItem>
        )}
      </KeyList>
    );
  },
);
