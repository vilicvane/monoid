import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import {ADDRESS_TYPES, ADDRESS_TYPE_LABELS} from '../../@lib/wallet-address.js';
import type {
  WalletKeyData,
  WalletKeyWalletData,
} from '../../@services/index.js';
import {getKeyWallets} from '../../@services/index.js';
import {InteractiveAddress} from '../@ui/interactive-address.js';

import {ExpandableKeyGroup, KeyGroupItem} from './expandable-key-group.js';
import {KeyCheckbox} from './key-checkbox.js';
import {
  KeyList,
  KeyListAddress,
  KeyListItem,
  KeyListItemContent,
  KeyListPlaceholder,
} from './key-list.js';
import {KeyAliasTag, KeyDerivationTag, KeyTags} from './key-tags.js';

type AccountGroup = {key: WalletKeyData; wallets: WalletKeyWalletData[]};
type SelectionProps = {
  selectedAddresses: ReadonlySet<string>;
  onToggle?: (address: string) => void;
  disabled?: boolean;
};

const WalletAccountGroup = observer(function WalletAccountGroup({
  group: {key, wallets},
  autoExpand,
  selectedAddresses,
  onToggle,
  disabled,
}: SelectionProps & {
  group: AccountGroup;
  autoExpand: boolean;
}): ReactNode {
  return (
    <ExpandableKeyGroup autoExpand={autoExpand}>
      {({expanded, revealing, expand}) => {
        const collapsed = wallets.length > 1 && !expanded;

        return (collapsed ? wallets.slice(0, 1) : wallets).map(
          (wallet, index) => (
            <KeyGroupItem
              as={onToggle ? 'label' : 'div'}
              key={wallet.address.toLowerCase()}
              $revealing={revealing && index > 0}
              disabled={collapsed ? disabled : undefined}
              aria-expanded={collapsed ? false : undefined}
              aria-label={
                collapsed
                  ? `Show ${wallets.length} accounts${key.alias ? ` for ${key.alias}` : ''}`
                  : undefined
              }
              onExpand={collapsed ? expand : undefined}
            >
              <KeyListItemContent>
                <KeyTags>
                  {onToggle && (
                    <KeyCheckbox
                      count={collapsed ? wallets.length : undefined}
                      aria-label={`Select ${wallet.address}`}
                      checked={selectedAddresses.has(
                        wallet.address.toLowerCase(),
                      )}
                      onChange={() => onToggle(wallet.address)}
                      disabled={disabled}
                    />
                  )}
                  {key.alias && <KeyAliasTag>{key.alias}</KeyAliasTag>}
                  <KeyDerivationTag
                    chain={ADDRESS_TYPES[wallet.addressType].chain}
                  >
                    {wallet.path ?? ADDRESS_TYPE_LABELS[wallet.addressType]}
                  </KeyDerivationTag>
                </KeyTags>
                {onToggle ? (
                  <KeyListAddress>{wallet.address}</KeyListAddress>
                ) : (
                  <KeyListAddress as={InteractiveAddress} copyable>
                    {wallet.address}
                  </KeyListAddress>
                )}
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
    addresses,
    additionalAddresses = addresses ?? [],
    selectedAddresses = new Set(),
    onToggle,
    disabled = false,
  }: {
    keys: readonly WalletKeyData[];
    addressType: 'evm';
    addresses?: readonly string[];
    additionalAddresses?: readonly string[];
  } & Partial<SelectionProps>): ReactNode => {
    const groups = new Map<WalletKeyData['index'], AccountGroup>();
    const included =
      addresses && new Set(addresses.map(address => address.toLowerCase()));
    const seen = new Set<string>();
    const selected = new Set(
      Array.from(selectedAddresses, address => address.toLowerCase()),
    );

    for (const key of keys) {
      for (const wallet of getKeyWallets(key)) {
        if (wallet.addressType !== addressType) continue;

        const address = wallet.address.toLowerCase();
        if (seen.has(address) || (included && !included.has(address))) continue;

        seen.add(address);
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
        {Array.from(groups, ([index, group]) => (
          <WalletAccountGroup
            key={index}
            group={group}
            autoExpand={
              !onToggle ||
              groups.size === 1 ||
              group.wallets.some(wallet =>
                selected.has(wallet.address.toLowerCase()),
              )
            }
            selectedAddresses={selected}
            onToggle={onToggle}
            disabled={disabled}
          />
        ))}
        {additionalAddresses
          .filter(address => !seen.has(address.toLowerCase()))
          .map(address => (
            <KeyListItem
              as={onToggle ? 'label' : 'div'}
              key={address.toLowerCase()}
            >
              <KeyListItemContent>
                <KeyTags>
                  {onToggle && (
                    <KeyCheckbox
                      aria-label={`Select ${address}`}
                      checked={selected.has(address.toLowerCase())}
                      onChange={() => onToggle(address)}
                      disabled={disabled}
                    />
                  )}
                  <KeyListPlaceholder>Not in Safe</KeyListPlaceholder>
                </KeyTags>
                {onToggle ? (
                  <KeyListAddress>{address}</KeyListAddress>
                ) : (
                  <KeyListAddress as={InteractiveAddress} copyable>
                    {address}
                  </KeyListAddress>
                )}
              </KeyListItemContent>
            </KeyListItem>
          ))}
        {!groups.size && !additionalAddresses.length && (
          <KeyListItem>
            <KeyListPlaceholder>
              {onToggle ? 'No EVM accounts in Safe.' : 'No accounts.'}
            </KeyListPlaceholder>
          </KeyListItem>
        )}
      </KeyList>
    );
  },
);
