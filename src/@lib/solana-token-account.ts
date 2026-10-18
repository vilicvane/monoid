import {base58, base64} from '@scure/base';

import {SOLANA_TOKEN_PROGRAM} from './solana-token-instruction.js';
import type {SolanaRPCRequest} from './solana-transaction-review.js';

export type SolanaTokenAccount = {
  kind: 'account';
  mint: string;
  owner: string;
};

export type SolanaTokenMint = {kind: 'mint'; decimals: number};

export type SolanaTokenAccountData = SolanaTokenAccount | SolanaTokenMint;

type AccountResponse = {
  owner: string;
  executable?: boolean;
  data: [string, string];
};

export async function loadSolanaTokenAccounts(
  addresses: readonly string[],
  request: SolanaRPCRequest,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, SolanaTokenAccountData>> {
  signal?.throwIfAborted();
  const uniqueAddresses = Array.from(new Set(addresses));
  const accounts = new Map<string, SolanaTokenAccountData>();

  for (let offset = 0; offset < uniqueAddresses.length; offset += 100) {
    const batch = uniqueAddresses.slice(offset, offset + 100);
    const response = (await request(
      'getMultipleAccounts',
      [batch, {encoding: 'base64', commitment: 'confirmed'}],
      signal,
    )) as {
      context: {slot: number};
      value: (AccountResponse | null)[];
    };
    signal?.throwIfAborted();

    if (
      !response ||
      !Number.isSafeInteger(response.context?.slot) ||
      response.context.slot < 0 ||
      !Array.isArray(response.value) ||
      response.value.length !== batch.length
    ) {
      throw new Error('Invalid Solana token account response.');
    }

    response.value.forEach((account, index) => {
      if (account === null) {
        return;
      }

      if (
        !account ||
        typeof account.owner !== 'string' ||
        (account.executable !== undefined &&
          typeof account.executable !== 'boolean') ||
        !Array.isArray(account.data) ||
        account.data.length !== 2 ||
        typeof account.data[0] !== 'string' ||
        account.data[1] !== 'base64'
      ) {
        throw new Error('Invalid Solana token account response.');
      }

      if (account.owner !== SOLANA_TOKEN_PROGRAM || account.executable) {
        return;
      }

      let data: Uint8Array;

      try {
        data = base64.decode(account.data[0]);

        if (base64.encode(data) !== account.data[0]) {
          throw new Error('Noncanonical base64.');
        }
      } catch {
        throw new Error('Invalid Solana token account encoding.');
      }

      const decoded = decodeTokenAccount(data);

      if (decoded) {
        accounts.set(batch[index], decoded);
      }
    });
  }

  return accounts;
}

function decodeTokenAccount(
  data: Uint8Array,
): SolanaTokenAccountData | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Classic SPL Token layouts and COption tags:
  // https://github.com/solana-program/token/blob/main/interface/src/state.rs
  if (
    data.length === 165 &&
    (data[108] === 1 || data[108] === 2) &&
    [72, 109, 129].every(offset => view.getUint32(offset, true) <= 1)
  ) {
    return {
      kind: 'account',
      mint: base58.encode(data.subarray(0, 32)),
      owner: base58.encode(data.subarray(32, 64)),
    };
  }

  if (
    data.length === 82 &&
    data[45] === 1 &&
    [0, 46].every(offset => view.getUint32(offset, true) <= 1)
  ) {
    return {kind: 'mint', decimals: data[44]};
  }

  return undefined;
}
