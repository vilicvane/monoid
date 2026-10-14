import {type ReactNode, useId} from 'react';
import {styled} from 'styled-components';

import type {AddressChain} from '../../@lib/wallet-address.js';

const Icon = styled.svg`
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  display: block;
`;

const CHAIN_LABELS: Record<AddressChain, string> = {
  evm: 'EVM',
  solana: 'Solana',
  bitcoin: 'Bitcoin',
};

export const AddressChainIcon = ({
  chain,
  className,
}: {
  chain: AddressChain;
  className?: string;
}): ReactNode => {
  const gradientId = useId();

  return (
    <Icon
      className={className}
      viewBox="0 0 24 24"
      role="img"
      aria-label={CHAIN_LABELS[chain]}
    >
      {chain === 'evm' && (
        <>
          <path d="m12 1 7 11-7 4-7-4Z" fill="#627eea" />
          <path d="m12 1 7 11-7 4Z" fill="#454a75" />
          <path d="m5 12 7-3 7 3-7 4Z" fill="#8c9bf1" />
          <path d="m12 9 7 3-7 4Z" fill="#627eea" />
          <path d="m5 14 7 4 7-4-7 9Z" fill="#627eea" />
          <path d="m12 18 7-4-7 9Z" fill="#454a75" />
        </>
      )}
      {chain === 'solana' && (
        <>
          <defs>
            <linearGradient
              id={gradientId}
              x1="20"
              y1="3"
              x2="4"
              y2="21"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#14f195" />
              <stop offset="1" stopColor="#9945ff" />
            </linearGradient>
          </defs>
          <path
            d="m6 4-4 4h16l4-4Zm-4 6 4 4h16l-4-4Zm4 6-4 4h16l4-4Z"
            fill={`url(#${gradientId})`}
          />
        </>
      )}
      {chain === 'bitcoin' && (
        <>
          <circle cx="12" cy="12" r="12" fill="#f7931a" />
          <g
            transform="rotate(14 12 12)"
            fill="none"
            stroke="#fff"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M8 6.5h5.3c3.2 0 3.2 5.1 0 5.1H9.5m0 0h4.2c3.7 0 3.7 5.4 0 5.4H8M9.5 6.5V17" />
            <path d="M11 4.5v2m3-2v2M11 17v2m3-2v2" />
          </g>
        </>
      )}
    </Icon>
  );
};
