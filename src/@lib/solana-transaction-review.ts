import {base58, base64} from '@scure/base';

import type {SolanaIdlInstruction} from './solana-idl.js';
import {
  type SolanaTokenInstruction,
  decodeSolanaTokenInstruction,
} from './solana-token-instruction.js';
import {
  type SolanaTokenReview,
  loadSolanaTokenReviews,
} from './solana-token-review.js';
import type {SolanaTransaction} from './solana-transaction.js';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const ADDRESS_LOOKUP_TABLE_PROGRAM =
  'AddressLookupTab1e1111111111111111111111111';
const ADDRESS_LOOKUP_TABLE_META_SIZE = 56;

export type SolanaTransactionAccount = {
  address: string;
  isSigner: boolean;
  isWritable: boolean;
};

export type SolanaInstructionData =
  | SolanaTokenInstruction
  | {kind: 'transfer'; from: string; to: string; lamports: bigint}
  | {kind: 'compute-unit-limit'; units: number}
  | {kind: 'compute-unit-price'; microLamports: bigint}
  | {kind: 'unknown'};

export type SolanaInstructionReview = {
  programAddress: string;
  accounts: SolanaTransactionAccount[];
  data: Uint8Array;
  decoded: SolanaInstructionData;
  token?: SolanaTokenReview;
  idl?: SolanaIdlInstruction;
};

export type SolanaTransactionReview = {
  feePayer: string;
  accounts: SolanaTransactionAccount[];
  instructions: SolanaInstructionReview[];
};

export type SolanaAddressLookupTables = ReadonlyMap<string, readonly string[]>;

export type SolanaRPCRequest = (
  method: string,
  params: readonly unknown[],
  signal?: AbortSignal,
) => Promise<unknown>;

export function reviewSolanaTransaction(
  transaction: SolanaTransaction,
  tables: SolanaAddressLookupTables = new Map(),
): SolanaTransactionReview {
  const {compiled} = transaction;
  const {header, staticAccounts} = compiled;
  const accounts: SolanaTransactionAccount[] = staticAccounts.map(
    (address, index) => {
      const isSigner = index < header.numSignerAccounts;

      return {
        address,
        isSigner,
        isWritable: isSigner
          ? index < header.numSignerAccounts - header.numReadonlySignerAccounts
          : index < staticAccounts.length - header.numReadonlyNonSignerAccounts,
      };
    },
  );
  const writable: SolanaTransactionAccount[] = [];
  const readonly: SolanaTransactionAccount[] = [];

  for (const lookup of compiled.version === 0
    ? (compiled.addressTableLookups ?? [])
    : []) {
    const addresses = tables.get(lookup.lookupTableAddress);

    if (!addresses) {
      throw new Error('Could not resolve a Solana address lookup table.');
    }

    for (const [indices, destination, isWritable] of [
      [lookup.writableIndexes, writable, true],
      [lookup.readonlyIndexes, readonly, false],
    ] as const) {
      for (const index of indices) {
        const address = addresses[index];

        if (!address) {
          throw new Error('The Solana address lookup table index is invalid.');
        }

        destination.push({address, isSigner: false, isWritable});
      }
    }
  }

  // Loaded accounts are grouped by role across all tables, not table by table.
  accounts.push(...writable, ...readonly);

  if (
    new Set(accounts.map(account => account.address)).size !== accounts.length
  ) {
    throw new Error('The Solana transaction contains duplicate accounts.');
  }

  const instructions = compiled.instructions.map(instruction => {
    const programAddress = accounts[instruction.programAddressIndex].address;
    const instructionAccounts = (instruction.accountIndices ?? []).map(
      index => accounts[index],
    );
    const data = Uint8Array.from(instruction.data ?? []);

    return {
      programAddress,
      accounts: instructionAccounts,
      data,
      decoded: decodeInstruction(programAddress, instructionAccounts, data),
    };
  });

  return {feePayer: transaction.feePayer, accounts, instructions};
}

export async function loadSolanaTransactionReviews(
  transactions: readonly SolanaTransaction[],
  request: SolanaRPCRequest,
  signal?: AbortSignal,
): Promise<SolanaTransactionReview[]> {
  signal?.throwIfAborted();
  const tableAddresses = Array.from(
    new Set(
      transactions.flatMap(transaction =>
        transaction.compiled.version === 0
          ? (transaction.compiled.addressTableLookups ?? []).map(
              lookup => lookup.lookupTableAddress,
            )
          : [],
      ),
    ),
  );
  const tables = new Map<string, readonly string[]>();

  // getMultipleAccounts accepts at most 100 addresses per request.
  for (let offset = 0; offset < tableAddresses.length; offset += 100) {
    const batch = tableAddresses.slice(offset, offset + 100);
    const response = (await request(
      'getMultipleAccounts',
      [batch, {encoding: 'base64', commitment: 'confirmed'}],
      signal,
    )) as {
      context: {slot: number};
      value: ({owner: string; data: [string, string]} | null)[];
    };
    signal?.throwIfAborted();

    if (
      !response ||
      !Array.isArray(response.value) ||
      response.value.length !== batch.length ||
      !Number.isSafeInteger(response.context?.slot) ||
      response.context.slot < 0
    ) {
      throw new Error('Invalid Solana address lookup table response.');
    }

    response.value.forEach((account, index) => {
      if (!account) {
        throw new Error('A Solana address lookup table was not found.');
      }

      if (
        account.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM ||
        !Array.isArray(account.data) ||
        typeof account.data[0] !== 'string' ||
        account.data[1] !== 'base64'
      ) {
        throw new Error('Invalid Solana address lookup table account.');
      }

      tables.set(
        batch[index],
        decodeAddressLookupTable(
          base64.decode(account.data[0]),
          BigInt(response.context.slot),
        ),
      );
    });
  }

  return loadSolanaTokenReviews(
    transactions.map(transaction =>
      reviewSolanaTransaction(transaction, tables),
    ),
    request,
    signal,
  );
}

function decodeAddressLookupTable(
  data: Uint8Array,
  currentSlot: bigint,
): string[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const addressCount = (data.length - ADDRESS_LOOKUP_TABLE_META_SIZE) / 32;

  // AddressLookupTable account state: fixed 56-byte metadata, then 32-byte addresses.
  // https://github.com/solana-program/address-lookup-table/blob/main/clients/js/src/generated/accounts/addressLookupTable.ts
  if (
    data.length < ADDRESS_LOOKUP_TABLE_META_SIZE ||
    !Number.isInteger(addressCount) ||
    addressCount > 256 ||
    view.getUint32(0, true) !== 1 ||
    data[21] > 1
  ) {
    throw new Error('Invalid Solana address lookup table data.');
  }

  // Deactivating tables require SlotHashes to establish their remaining lifetime.
  // Only fully active tables are supported until that check is implemented.
  if (view.getBigUint64(4, true) !== BigInt('18446744073709551615')) {
    throw new Error(
      'Deactivating Solana address lookup tables are not supported.',
    );
  }

  const lastExtendedSlot = view.getBigUint64(12, true);
  const lastExtendedSlotStartIndex = data[20];

  if (
    lastExtendedSlot > currentSlot ||
    lastExtendedSlotStartIndex > addressCount
  ) {
    throw new Error('Invalid Solana address lookup table metadata.');
  }

  // Newly appended entries become usable only after the extension's slot.
  const activeAddressCount =
    currentSlot > lastExtendedSlot ? addressCount : lastExtendedSlotStartIndex;

  return Array.from({length: activeAddressCount}, (_, index) => {
    const offset = ADDRESS_LOOKUP_TABLE_META_SIZE + index * 32;
    return base58.encode(data.subarray(offset, offset + 32));
  });
}

function decodeInstruction(
  programAddress: string,
  accounts: readonly SolanaTransactionAccount[],
  data: Uint8Array,
): SolanaInstructionData {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  if (
    programAddress === SYSTEM_PROGRAM &&
    data.length === 12 &&
    view.getUint32(0, true) === 2 &&
    accounts.length === 2 &&
    accounts[0].isSigner &&
    accounts[0].isWritable &&
    accounts[1].isWritable
  ) {
    return {
      kind: 'transfer',
      from: accounts[0].address,
      to: accounts[1].address,
      lamports: view.getBigUint64(4, true),
    };
  }

  if (programAddress === COMPUTE_BUDGET_PROGRAM && accounts.length === 0) {
    if (data.length === 5 && data[0] === 2) {
      return {kind: 'compute-unit-limit', units: view.getUint32(1, true)};
    }
    if (data.length === 9 && data[0] === 3) {
      return {
        kind: 'compute-unit-price',
        microLamports: view.getBigUint64(1, true),
      };
    }
  }

  return (
    decodeSolanaTokenInstruction(programAddress, accounts, data) ?? {
      kind: 'unknown',
    }
  );
}
