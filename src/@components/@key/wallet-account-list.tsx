import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {UnmountAnimationClone} from 'unmount-animation-clone';

import {normalizeWalletAddress} from '../../@lib/wallet-address.js';
import type {
  WalletKeyData,
  WalletKeyWalletData,
} from '../../@services/index.js';
import {getKeyWallets} from '../../@services/index.js';
import {InteractiveAddress} from '../@ui/interactive-address.js';
import {RippleEffect} from '../@ui/ripple-effect.js';

import {ExpandableKeyGroup, KeyGroupItem} from './expandable-key-group.js';
import {KeyCheckbox} from './key-checkbox.js';
import {
  KeyList,
  KeyListAddress,
  KeyListItem,
  KeyListItemContent,
  KeyListPlaceholder,
} from './key-list.js';
import {KeyDerivationBadge, KeyTags} from './key-tags.js';
import {WalletAccountTags} from './wallet-account-tags.js';

type AccountGroup = {key: WalletKeyData; wallets: WalletKeyWalletData[]};
type SelectionProps = {
  selectedAddresses: ReadonlySet<string>;
  onToggle?: (address: string) => void;
  onOpen?: (address: string) => void;
  renderStatus?: (addresses: readonly string[]) => ReactNode;
  disabled?: boolean;
};

const WalletAccountGroup = observer(function WalletAccountGroup({
  group: {key, wallets},
  autoExpand,
  showAddressType,
  selectedAddresses,
  onToggle,
  onOpen,
  renderStatus,
  disabled,
}: SelectionProps & {
  group: AccountGroup;
  autoExpand: boolean;
  showAddressType: boolean;
}): ReactNode {
  return (
    <ExpandableKeyGroup
      autoExpand={autoExpand}
      focusSelector={onOpen ? 'button' : 'input'}
    >
      {({expanded, revealing, expand}) => {
        const collapsed = wallets.length > 1 && !expanded;

        return (collapsed ? wallets.slice(0, 1) : wallets).map(
          (wallet, index) => {
            const status = renderStatus?.(
              collapsed
                ? wallets.map(wallet => wallet.address)
                : [wallet.address],
            );
            const hasTags = !!(key.alias || wallet.path || showAddressType);

            return (
              <KeyGroupItem
                as={onToggle ? 'label' : onOpen ? 'button' : 'div'}
                key={normalizeWalletAddress(wallet.address)}
                className={onOpen ? 'ion-activatable' : undefined}
                $revealing={revealing && index > 0}
                disabled={collapsed || onOpen ? disabled : undefined}
                aria-expanded={collapsed ? false : undefined}
                aria-label={
                  collapsed
                    ? `Show ${wallets.length} accounts${key.alias ? ` for ${key.alias}` : ''}`
                    : undefined
                }
                onExpand={collapsed ? expand : undefined}
                onClick={onOpen ? () => onOpen(wallet.address) : undefined}
              >
                {onToggle && (
                  <KeyCheckbox
                    count={collapsed ? wallets.length : undefined}
                    aria-label={`Select ${wallet.address}`}
                    checked={selectedAddresses.has(
                      normalizeWalletAddress(wallet.address),
                    )}
                    onChange={() => onToggle(wallet.address)}
                    disabled={disabled}
                  />
                )}
                <KeyListItemContent>
                  {hasTags && (
                    <KeyTags>
                      <WalletAccountTags
                        alias={key.alias}
                        wallet={wallet}
                        showAddressType={showAddressType}
                      />
                      {onOpen && collapsed && (
                        <UnmountAnimationClone>
                          <KeyDerivationBadge $primary $revealing>
                            {wallets.length}
                          </KeyDerivationBadge>
                        </UnmountAnimationClone>
                      )}
                      {status}
                    </KeyTags>
                  )}
                  {onToggle || onOpen ? (
                    <KeyListAddress>{wallet.address}</KeyListAddress>
                  ) : (
                    <KeyListAddress as={InteractiveAddress} copyable>
                      {wallet.address}
                    </KeyListAddress>
                  )}
                </KeyListItemContent>
                {!hasTags && status}
                {onOpen && !disabled && <RippleEffect />}
              </KeyGroupItem>
            );
          },
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
    compact = false,
    compactContent = false,
    contained = false,
    additionalAddresses = addresses ?? [],
    selectedAddresses = new Set(),
    onToggle,
    onOpen,
    renderStatus,
    disabled = false,
  }: {
    keys: readonly WalletKeyData[];
    addressType: 'evm' | 'solana' | readonly ('evm' | 'solana')[];
    addresses?: readonly string[];
    compact?: boolean;
    compactContent?: boolean;
    contained?: boolean;
    additionalAddresses?: readonly string[];
  } & Partial<SelectionProps>): ReactNode => {
    const groups = new Map<WalletKeyData['index'], AccountGroup>();
    const addressTypes =
      typeof addressType === 'string' ? [addressType] : addressType;
    const included =
      addresses && new Set(addresses.map(normalizeWalletAddress));
    const seen = new Set<string>();
    const selected = new Set(
      Array.from(selectedAddresses, normalizeWalletAddress),
    );

    for (const key of keys) {
      for (const wallet of getKeyWallets(key)) {
        if (!addressTypes.some(type => type === wallet.addressType)) continue;

        const address = normalizeWalletAddress(wallet.address);
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
      <KeyList
        $compact={compact}
        $compactContent={compactContent}
        $contained={contained}
      >
        {Array.from(groups, ([index, group]) => (
          <WalletAccountGroup
            key={index}
            group={group}
            showAddressType={!!onOpen || addressTypes.length > 1}
            autoExpand={
              (!onToggle && !onOpen) ||
              groups.size === 1 ||
              group.wallets.some(wallet =>
                selected.has(normalizeWalletAddress(wallet.address)),
              )
            }
            selectedAddresses={selected}
            onToggle={onToggle}
            onOpen={onToggle ? undefined : onOpen}
            renderStatus={renderStatus}
            disabled={disabled}
          />
        ))}
        {additionalAddresses
          .filter(address => !seen.has(normalizeWalletAddress(address)))
          .map(address => (
            <KeyGroupItem
              as={onToggle ? 'label' : onOpen ? 'button' : 'div'}
              key={normalizeWalletAddress(address)}
              className={!onToggle && onOpen ? 'ion-activatable' : undefined}
              disabled={disabled}
              onClick={!onToggle && onOpen ? () => onOpen(address) : undefined}
            >
              {onToggle && (
                <KeyCheckbox
                  aria-label={`Select ${address}`}
                  checked={selected.has(normalizeWalletAddress(address))}
                  onChange={() => onToggle(address)}
                  disabled={disabled}
                />
              )}
              <KeyListItemContent>
                <KeyTags>
                  <KeyListPlaceholder>Not in Safe</KeyListPlaceholder>
                  {renderStatus?.([address])}
                </KeyTags>
                {onToggle || onOpen ? (
                  <KeyListAddress>{address}</KeyListAddress>
                ) : (
                  <KeyListAddress as={InteractiveAddress} copyable>
                    {address}
                  </KeyListAddress>
                )}
              </KeyListItemContent>
              {!onToggle && onOpen && !disabled && <RippleEffect />}
            </KeyGroupItem>
          ))}
        {!groups.size && !additionalAddresses.length && (
          <KeyListItem>
            <KeyListPlaceholder>
              {onToggle
                ? addressTypes.length === 1
                  ? `No ${addressTypes[0] === 'evm' ? 'EVM' : 'Solana'} accounts in Safe.`
                  : 'No accounts in Safe.'
                : 'No accounts.'}
            </KeyListPlaceholder>
          </KeyListItem>
        )}
      </KeyList>
    );
  },
);
