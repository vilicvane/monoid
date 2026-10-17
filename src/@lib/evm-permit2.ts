import {type TypedDataField, getAddress} from 'ethers';

import type {EvmTypedData} from './evm-typed-data.js';

export type EvmPermit2 = {
  chainId: `eip155:${string}`;
  spender: string;
  sigDeadline: bigint;
  details: {
    path: string;
    token: string;
    amount: bigint;
    expiration: bigint;
    nonce: bigint;
  }[];
};

const DOMAIN_FIELDS = [
  {name: 'name', type: 'string'},
  {name: 'chainId', type: 'uint256'},
  {name: 'verifyingContract', type: 'address'},
];
const DETAIL_FIELDS = [
  {name: 'token', type: 'address'},
  {name: 'amount', type: 'uint160'},
  {name: 'expiration', type: 'uint48'},
  {name: 'nonce', type: 'uint48'},
];

// Recognize normalized, validated signed data. Canonical address matching does
// not assert that a deployment exists on an arbitrary chain.
export function getEvmPermit2(data: EvmTypedData): EvmPermit2 | undefined {
  const batch = data.primaryType === 'PermitBatch';
  if (!batch && data.primaryType !== 'PermitSingle') return undefined;

  if (
    data.domain.name !== 'Permit2' ||
    !matchesFields(data.types.EIP712Domain, DOMAIN_FIELDS) ||
    !matchesFields(data.types.PermitDetails, DETAIL_FIELDS) ||
    !matchesFields(data.types[data.primaryType], [
      {name: 'details', type: batch ? 'PermitDetails[]' : 'PermitDetails'},
      {name: 'spender', type: 'address'},
      {name: 'sigDeadline', type: 'uint256'},
    ])
  ) {
    return undefined;
  }

  const chainId = BigInt(data.domain.chainId!);
  // https://github.com/Uniswap/sdks/blob/main/sdks/permit2-sdk/src/constants.ts
  const contract =
    chainId === BigInt(324)
      ? '0x0000000000225e31D15943971F47aD3022F714Fa'
      : '0x000000000022D473030F116dDEE9F6B43aC78BA3';

  if (
    chainId <= BigInt(0) ||
    getAddress(data.domain.verifyingContract!) !== contract
  ) {
    return undefined;
  }

  const details = (
    batch ? data.message.details : [data.message.details]
  ) as Record<string, string>[];

  return {
    chainId: `eip155:${chainId}`,
    spender: getAddress(data.message.spender as string),
    sigDeadline: BigInt(data.message.sigDeadline as string),
    details: details.map((detail, index) => ({
      path: batch ? `0.${index}` : '0',
      token: getAddress(detail.token!),
      amount: BigInt(detail.amount!),
      expiration: BigInt(detail.expiration!),
      nonce: BigInt(detail.nonce!),
    })),
  };
}

function matchesFields(
  actual: TypedDataField[] | undefined,
  expected: TypedDataField[],
): boolean {
  return (
    actual?.length === expected.length &&
    actual.every(
      (field, index) =>
        field.name === expected[index]!.name &&
        field.type === expected[index]!.type,
    )
  );
}
