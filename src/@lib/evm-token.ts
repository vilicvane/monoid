import {Interface, type Provider, getAddress} from 'ethers';

import type {AddressKind} from './address-status.js';
import type {EvmCalldata} from './evm-calldata.js';

export type EvmToken = {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals?: number;
  logoURI?: string;
};

export function getEvmTokenAddressKind(
  kind: AddressKind,
  listed: boolean,
): AddressKind {
  return listed && (kind === 'unknown' || kind === 'seen') ? 'listed' : kind;
}

const ERC20 = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]);

export function getErc20CallTarget(data: EvmCalldata): string | undefined {
  return data.candidates.length === 1 &&
    data.issue !== 'limit' &&
    getErc20AmountIndex(data.candidates[0].signature) !== undefined
    ? data.target
    : undefined;
}

export async function readEvmToken(
  provider: Pick<Provider, 'call'>,
  chainId: string,
  address: string,
): Promise<EvmToken> {
  const read = async (
    method: string,
    args: string[] = [],
  ): Promise<string | bigint> => {
    const result = await provider.call({
      to: address,
      data: ERC20.encodeFunctionData(method, args),
      enableCcipRead: false,
    });
    return ERC20.decodeFunctionResult(method, result)[0] as string | bigint;
  };

  // Shared transfer selectors alone do not distinguish ERC-20 from ERC-721.
  // Metadata is optional and remains contract-reported, not a trust signal.
  const [, name, symbol, decimals] = await Promise.all([
    Promise.all([
      read('totalSupply'),
      read('balanceOf', [address]),
      read('allowance', [address, address]),
    ]),
    read('name').catch(() => undefined),
    read('symbol').catch(() => undefined),
    read('decimals').catch(() => undefined),
  ]);

  return {
    chainId: Number(chainId.split(':')[1]),
    address: getAddress(address),
    name: typeof name === 'string' && name.trim() ? name.trim() : 'ERC-20',
    symbol:
      typeof symbol === 'string' && symbol.trim() ? symbol.trim() : 'ERC-20',
    decimals: decimals === undefined ? undefined : Number(decimals),
  };
}

export function parseEvmTokenList(value: unknown): EvmToken[] {
  if (
    !value ||
    typeof value !== 'object' ||
    !('tokens' in value) ||
    !Array.isArray(value.tokens) ||
    !value.tokens.length
  ) {
    throw new Error('Invalid token list.');
  }

  const keys = new Set<string>();
  return value.tokens.flatMap((token: unknown) => {
    // Uniswap also publishes Solana tokens under this non-EVM identifier.
    if (
      token &&
      typeof token === 'object' &&
      'chainId' in token &&
      token.chainId === 501000101
    )
      return [];
    if (
      !token ||
      typeof token !== 'object' ||
      !('chainId' in token) ||
      typeof token.chainId !== 'number' ||
      !Number.isSafeInteger(token.chainId) ||
      token.chainId <= 0 ||
      !('address' in token) ||
      typeof token.address !== 'string' ||
      !/^0x[\da-f]{40}$/i.test(token.address) ||
      !('name' in token) ||
      typeof token.name !== 'string' ||
      !token.name.trim() ||
      !('symbol' in token) ||
      typeof token.symbol !== 'string' ||
      !token.symbol.trim() ||
      !('decimals' in token) ||
      typeof token.decimals !== 'number' ||
      !Number.isInteger(token.decimals) ||
      token.decimals < 0 ||
      token.decimals > 255
    ) {
      throw new Error('Invalid token list entry.');
    }

    const key = `${token.chainId}:${token.address.toLowerCase()}`;
    if (keys.has(key)) throw new Error('Duplicate token list entry.');
    keys.add(key);

    return {
      chainId: token.chainId,
      address: getAddress(token.address),
      name: token.name.trim(),
      symbol: token.symbol.trim(),
      decimals: token.decimals,
      logoURI:
        'logoURI' in token &&
        typeof token.logoURI === 'string' &&
        token.logoURI.startsWith('https://')
          ? token.logoURI
          : undefined,
    };
  });
}

// Work with decimal strings, including ERC-20 precisions beyond formatUnits' limit.
export function formatTokenAmount(value: bigint, decimals: number): string {
  if (!decimals) return value.toString();
  const sign = value < 0 ? '-' : '';
  const digits = (value < 0 ? -value : value)
    .toString()
    .padStart(decimals + 1, '0');
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return sign + digits.slice(0, -decimals) + (fraction ? `.${fraction}` : '');
}

export function getErc20AmountIndex(signature: string): number | undefined {
  switch (signature) {
    case 'transfer(address,uint256)':
    case 'approve(address,uint256)':
      return 1;
    case 'transferFrom(address,address,uint256)':
      return 2;
    default:
      return undefined;
  }
}
