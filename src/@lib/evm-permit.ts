import {ZeroAddress, getAddress} from 'ethers';

import type {EvmTypedData} from './evm-typed-data.js';

export type EvmPermit = {
  chainId: `eip155:${string}`;
  token: string;
  owner: string;
  spender: string;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
};

const PERMIT_FIELDS = [
  {name: 'owner', type: 'address'},
  {name: 'spender', type: 'address'},
  {name: 'value', type: 'uint256'},
  {name: 'nonce', type: 'uint256'},
  {name: 'deadline', type: 'uint256'},
];

// Recognize normalized, validated typed data without rebuilding what is signed.
// Matching the ERC-2612 schema does not verify the token contract's behavior.
export function getEvmPermit(data: EvmTypedData): EvmPermit | undefined {
  const fields = data.types.Permit;

  if (
    data.primaryType !== 'Permit' ||
    fields?.length !== PERMIT_FIELDS.length ||
    fields.some(
      (field, index) =>
        field.name !== PERMIT_FIELDS[index].name ||
        field.type !== PERMIT_FIELDS[index].type,
    ) ||
    data.domain.chainId === undefined ||
    data.domain.verifyingContract === undefined
  ) {
    return undefined;
  }

  const chainId = BigInt(data.domain.chainId);
  const token = getAddress(data.domain.verifyingContract);

  if (chainId <= BigInt(0) || token === ZeroAddress) return undefined;

  return {
    chainId: `eip155:${chainId}`,
    token,
    owner: getAddress(data.message.owner as string),
    spender: getAddress(data.message.spender as string),
    value: BigInt(data.message.value as string),
    nonce: BigInt(data.message.nonce as string),
    deadline: BigInt(data.message.deadline as string),
  };
}
