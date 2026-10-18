import {type ReactNode, useState} from 'react';
import {styled} from 'styled-components';

import type {AddressChain, AddressType} from '../../@lib/wallet-address.js';
import {ADDRESS_TYPES} from '../../@lib/wallet-address.js';
import {SegmentedControl} from '../@ui/segmented-control.js';

import {AddressChainIcon} from './address-chain-icon.js';

const Container = styled.div`
  display: flex;
  flex-direction: column;
`;

const BitcoinOptions = styled.div<{$expanded: boolean}>`
  display: grid;
  grid-template-rows: ${({$expanded}) => ($expanded ? '1fr' : '0fr')};
  margin: ${({$expanded}) =>
      $expanded ? 'var(--address-selector-gap, 8px)' : '0'} -2px
    0;
  opacity: ${({$expanded}) => ($expanded ? 1 : 0)};
  transition:
    grid-template-rows 200ms ease-in-out,
    margin-top 200ms ease-in-out,
    opacity 200ms ease-in-out;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

const BitcoinOptionsContent = styled.div`
  min-height: 0;
  padding: 0 2px;
  overflow: hidden;
`;

const ALL_ADDRESS_TYPES: readonly AddressType[] = [
  'evm',
  'solana',
  'bitcoin-segwit',
  'bitcoin-taproot',
];

export const ADDRESS_CHAIN_OPTIONS = [
  {value: 'evm', label: 'EVM', icon: <AddressChainIcon chain="evm" />},
  {value: 'solana', label: 'Solana', icon: <AddressChainIcon chain="solana" />},
  {value: 'bitcoin', label: 'BTC', icon: <AddressChainIcon chain="bitcoin" />},
] as const;

const BITCOIN_TYPE_OPTIONS = [
  {
    value: 'bitcoin-segwit',
    label: 'Native SegWit',
    icon: <AddressChainIcon chain="bitcoin" />,
  },
  {
    value: 'bitcoin-taproot',
    label: 'Taproot',
    icon: <AddressChainIcon chain="bitcoin" />,
  },
] as const;

type BitcoinAddressType = (typeof BITCOIN_TYPE_OPTIONS)[number]['value'];

export const AddressTypeSelector = ({
  value,
  onChange,
  addressTypes = ALL_ADDRESS_TYPES,
}: {
  value: AddressType;
  onChange: (value: AddressType) => void;
  addressTypes?: readonly AddressType[];
}): ReactNode => {
  const chain = ADDRESS_TYPES[value].chain;
  const [bitcoinType, setBitcoinType] = useState<BitcoinAddressType>(
    value === 'bitcoin-taproot' ? value : 'bitcoin-segwit',
  );
  const chainOptions = ADDRESS_CHAIN_OPTIONS.filter(option =>
    addressTypes.some(type => ADDRESS_TYPES[type].chain === option.value),
  );
  const bitcoinOptions = BITCOIN_TYPE_OPTIONS.filter(option =>
    addressTypes.includes(option.value),
  );

  const onChainChange = (nextChain: AddressChain): void => {
    if (value === 'bitcoin-segwit' || value === 'bitcoin-taproot') {
      setBitcoinType(value);
    }

    onChange(
      nextChain === 'bitcoin'
        ? (
            bitcoinOptions.find(option => option.value === bitcoinType) ??
            bitcoinOptions[0]
          ).value
        : nextChain,
    );
  };

  return (
    <Container>
      <SegmentedControl
        aria-label="Address chain"
        value={chain}
        options={chainOptions}
        onChange={onChainChange}
      />
      {bitcoinOptions.length > 0 && (
        <BitcoinOptions
          $expanded={chain === 'bitcoin'}
          aria-hidden={chain !== 'bitcoin'}
          inert={chain !== 'bitcoin'}
        >
          <BitcoinOptionsContent>
            <SegmentedControl
              aria-label="Bitcoin address type"
              value={chain === 'bitcoin' ? value : bitcoinType}
              options={bitcoinOptions}
              onChange={onChange}
            />
          </BitcoinOptionsContent>
        </BitcoinOptions>
      )}
    </Container>
  );
};
