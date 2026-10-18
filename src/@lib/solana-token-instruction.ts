import {ed25519} from '@noble/curves/ed25519.js';
import {base58} from '@scure/base';
import {getBytes, sha256} from 'ethers';

import type {SolanaTransactionAccount} from './solana-transaction-review.js';

export const SOLANA_TOKEN_PROGRAM =
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SOLANA_ASSOCIATED_TOKEN_PROGRAM =
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111';
const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

type SolanaTokenAuthority = {
  authority: string;
  additionalSigners?: string[];
};

export type SolanaTokenInstruction =
  | (SolanaTokenAuthority & {
      kind: 'token-transfer';
      source: string;
      destination: string;
      amount: bigint;
      mint?: string;
      decimals?: number;
    })
  | (SolanaTokenAuthority & {
      kind: 'token-approve';
      source: string;
      delegate: string;
      amount: bigint;
      mint?: string;
      decimals?: number;
    })
  | (SolanaTokenAuthority & {kind: 'token-revoke'; source: string})
  | {
      kind: 'token-account-create';
      account: string;
      owner: string;
      mint: string;
      payer: string;
      idempotent: boolean;
    };

export function isSolanaTokenInstruction(value: {
  kind: string;
}): value is SolanaTokenInstruction {
  return (
    value.kind === 'token-transfer' ||
    value.kind === 'token-approve' ||
    value.kind === 'token-revoke' ||
    value.kind === 'token-account-create'
  );
}

export function decodeSolanaTokenInstruction(
  programAddress: string,
  accounts: readonly SolanaTransactionAccount[],
  data: Uint8Array,
): SolanaTokenInstruction | undefined {
  if (programAddress === SOLANA_ASSOCIATED_TOKEN_PROGRAM) {
    return decodeAssociatedTokenInstruction(accounts, data);
  }

  if (programAddress !== SOLANA_TOKEN_PROGRAM) {
    return undefined;
  }

  // Classic SPL Token layouts; Token-2022 extensions remain an unknown instruction.
  // https://github.com/solana-program/token/blob/main/interface/src/instruction.rs
  const instruction = data[0];

  if (instruction === 5 && data.length === 1 && accounts[0]?.isWritable) {
    const authority = decodeAuthority(accounts, 1);

    return authority
      ? {kind: 'token-revoke', source: accounts[0].address, ...authority}
      : undefined;
  }

  const transfer = instruction === 3 || instruction === 12;
  const approve = instruction === 4 || instruction === 13;
  const checked = instruction === 12 || instruction === 13;
  const destinationIndex = checked ? 2 : 1;

  if (
    (!transfer && !approve) ||
    data.length !== (checked ? 10 : 9) ||
    !accounts[0]?.isWritable ||
    !accounts[destinationIndex] ||
    (transfer && !accounts[destinationIndex].isWritable)
  ) {
    return undefined;
  }

  const authority = decodeAuthority(accounts, destinationIndex + 1);

  if (!authority) {
    return undefined;
  }

  const amount = new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  ).getBigUint64(1, true);
  const token = checked ? {mint: accounts[1].address, decimals: data[9]} : {};
  const source = accounts[0].address;

  return transfer
    ? {
        kind: 'token-transfer',
        source,
        destination: accounts[destinationIndex].address,
        amount,
        ...token,
        ...authority,
      }
    : {
        kind: 'token-approve',
        source,
        delegate: accounts[destinationIndex].address,
        amount,
        ...token,
        ...authority,
      };
}

function decodeAuthority(
  accounts: readonly SolanaTransactionAccount[],
  index: number,
): SolanaTokenAuthority | undefined {
  const authority = accounts[index];

  if (!authority) {
    return undefined;
  }

  const signers = accounts.slice(index + 1);

  if (!signers.length) {
    return authority.isSigner ? {authority: authority.address} : undefined;
  }

  if (signers.length > 11 || signers.some(signer => !signer.isSigner)) {
    return undefined;
  }

  // Roles are transaction-wide: another instruction may promote a readonly account.
  // Keep additional signer accounts visible instead of discarding them.
  return {
    authority: authority.address,
    additionalSigners: signers.map(signer => signer.address),
  };
}

function decodeAssociatedTokenInstruction(
  accounts: readonly SolanaTransactionAccount[],
  data: Uint8Array,
): SolanaTokenInstruction | undefined {
  // https://github.com/solana-program/associated-token-account/blob/main/interface/src/instruction.rs
  // Original Create instructions have empty data and may include the rent sysvar.
  if (
    (data.length !== 0 &&
      (data.length !== 1 || (data[0] !== 0 && data[0] !== 1))) ||
    (accounts.length !== 6 &&
      (accounts.length !== 7 || accounts[6].address !== RENT_SYSVAR)) ||
    !accounts[0]?.isSigner ||
    !accounts[0].isWritable ||
    !accounts[1].isWritable ||
    accounts[4].address !== SYSTEM_PROGRAM ||
    accounts[5].address !== SOLANA_TOKEN_PROGRAM ||
    !isAssociatedTokenAddress(
      accounts[1].address,
      accounts[2].address,
      accounts[3].address,
    )
  ) {
    return undefined;
  }

  return {
    kind: 'token-account-create',
    account: accounts[1].address,
    owner: accounts[2].address,
    mint: accounts[3].address,
    payer: accounts[0].address,
    idempotent: data[0] === 1,
  };
}

function isAssociatedTokenAddress(
  account: string,
  owner: string,
  mint: string,
): boolean {
  let ownerBytes: Uint8Array;
  let mintBytes: Uint8Array;

  try {
    ownerBytes = base58.decode(owner);
    mintBytes = base58.decode(mint);
  } catch {
    return false;
  }

  if (ownerBytes.length !== 32 || mintBytes.length !== 32) {
    return false;
  }

  const seeds = Uint8Array.from([
    ...ownerBytes,
    ...base58.decode(SOLANA_TOKEN_PROGRAM),
    ...mintBytes,
    255,
    ...base58.decode(SOLANA_ASSOCIATED_TOKEN_PROGRAM),
    ...PDA_MARKER,
  ]);

  for (let bump = 255; bump >= 0; bump--) {
    seeds[96] = bump;
    const derived = getBytes(sha256(seeds));

    if (!ed25519.utils.isValidPublicKey(derived, true)) {
      return base58.encode(derived) === account;
    }
  }

  return false;
}
