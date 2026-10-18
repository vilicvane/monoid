import {base58} from '@scure/base';

type TokenBalance = {amount: bigint; owner?: string};

export type SolanaTransactionBalances = {
  native?: {address: string; before: bigint; after: bigint}[];
  tokens?: {
    address: string;
    mint: string;
    decimals: number;
    programId?: string;
    before?: TokenBalance;
    after?: TokenBalance;
  }[];
};

export type SolanaTokenBalanceChange = {
  owner?: string;
  account?: string;
  mint: string;
  decimals: number;
  programId?: string;
  value: bigint;
};

type IndexedTokenBalance = TokenBalance & {
  mint: string;
  decimals: number;
  programId?: string;
};

export function parseSolanaTransactionBalances(
  result: unknown,
): SolanaTransactionBalances {
  if (
    !isRecord(result) ||
    !isRecord(result.transaction) ||
    !isRecord(result.transaction.message) ||
    !isRecord(result.meta)
  ) {
    return {};
  }
  const {meta} = result;
  const addresses = getAccountKeys(
    result.transaction.message,
    meta.loadedAddresses,
    result.version,
  );
  if (!addresses) return {};

  const balances: SolanaTransactionBalances = {};
  const {preBalances, postBalances} = meta;
  if (
    Array.isArray(preBalances) &&
    Array.isArray(postBalances) &&
    preBalances.length === addresses.length &&
    postBalances.length === addresses.length &&
    preBalances.every(isLamports) &&
    postBalances.every(isLamports)
  ) {
    balances.native = addresses.map((address, index) => ({
      address,
      before: BigInt(preBalances[index] as number),
      after: BigInt(postBalances[index] as number),
    }));
  }

  // Missing balance arrays are unavailable data, not an empty token portfolio.
  const decimals = new Map<string, number>();
  const before = parseTokenBalances(
    meta.preTokenBalances,
    addresses.length,
    decimals,
  );
  const after = parseTokenBalances(
    meta.postTokenBalances,
    addresses.length,
    decimals,
  );
  if (!before || !after) return balances;

  const tokens: NonNullable<SolanaTransactionBalances['tokens']> = [];
  for (const index of new Set([...before.keys(), ...after.keys()])) {
    const first = before.get(index);
    const last = after.get(index);
    const address = addresses[index];
    if (
      first &&
      last &&
      first.mint === last.mint &&
      (first.programId === undefined ||
        last.programId === undefined ||
        first.programId === last.programId)
    ) {
      tokens.push({
        address,
        mint: first.mint,
        decimals: first.decimals,
        programId: first.programId ?? last.programId,
        before: {amount: first.amount, owner: first.owner},
        after: {amount: last.amount, owner: last.owner},
      });
    } else {
      // Closing and recreating an account may change its mint or token program.
      if (first) {
        tokens.push({
          address,
          mint: first.mint,
          decimals: first.decimals,
          programId: first.programId,
          before: {amount: first.amount, owner: first.owner},
        });
      }
      if (last) {
        tokens.push({
          address,
          mint: last.mint,
          decimals: last.decimals,
          programId: last.programId,
          after: {amount: last.amount, owner: last.owner},
        });
      }
    }
  }
  balances.tokens = tokens;
  return balances;
}

export function getSolanaTokenBalanceChanges(
  balances: SolanaTransactionBalances,
): SolanaTokenBalanceChange[] {
  const changes = new Map<string, SolanaTokenBalanceChange>();
  for (const {
    address,
    mint,
    decimals,
    programId,
    before,
    after,
  } of balances.tokens ?? []) {
    for (const [balance, direction] of [
      [before, BigInt(-1)],
      [after, BigInt(1)],
    ] as const) {
      if (!balance) continue;
      const {owner, amount} = balance;
      const key = `${owner ? `owner:${owner}` : `account:${address}`}:${mint}:${programId ?? ''}`;
      let change = changes.get(key);
      if (!change) {
        change = {
          owner,
          account: owner ? undefined : address,
          mint,
          decimals,
          programId,
          value: BigInt(0),
        };
        changes.set(key, change);
      }
      change.value += direction * amount;
    }
  }
  return [...changes.values()].filter(({value}) => value !== BigInt(0));
}

function getAccountKeys(
  message: Record<string, unknown>,
  loaded: unknown,
  version: unknown,
): string[] | undefined {
  const {accountKeys, addressTableLookups} = message;
  if (
    !Array.isArray(accountKeys) ||
    !accountKeys.length ||
    !accountKeys.every(isAddress) ||
    (version !== undefined && version !== 'legacy' && version !== 0)
  )
    return undefined;

  let writableCount = 0;
  let readonlyCount = 0;
  if (addressTableLookups !== undefined) {
    if (!Array.isArray(addressTableLookups)) return undefined;
    for (const lookup of addressTableLookups) {
      if (
        !isRecord(lookup) ||
        !isAddress(lookup.accountKey) ||
        !isLookupIndexes(lookup.writableIndexes) ||
        !isLookupIndexes(lookup.readonlyIndexes)
      )
        return undefined;
      writableCount += lookup.writableIndexes.length;
      readonlyCount += lookup.readonlyIndexes.length;
    }
  } else if (version === 0) {
    return undefined;
  }

  let addresses: string[];
  if (loaded === undefined) {
    if (writableCount || readonlyCount) return undefined;
    addresses = [...accountKeys] as string[];
  } else {
    if (
      !isRecord(loaded) ||
      !Array.isArray(loaded.writable) ||
      !Array.isArray(loaded.readonly) ||
      !loaded.writable.every(isAddress) ||
      !loaded.readonly.every(isAddress) ||
      loaded.writable.length !== writableCount ||
      loaded.readonly.length !== readonlyCount
    )
      return undefined;
    addresses = [
      ...accountKeys,
      ...loaded.writable,
      ...loaded.readonly,
    ] as string[];
  }
  return addresses.length <= 256 && new Set(addresses).size === addresses.length
    ? addresses
    : undefined;
}

function parseTokenBalances(
  source: unknown,
  accountCount: number,
  decimalsByMint: Map<string, number>,
): Map<number, IndexedTokenBalance> | undefined {
  if (!Array.isArray(source)) return undefined;
  const balances = new Map<number, IndexedTokenBalance>();
  for (const entry of source) {
    if (
      !isRecord(entry) ||
      !Number.isInteger(entry.accountIndex) ||
      (entry.accountIndex as number) < 0 ||
      (entry.accountIndex as number) >= accountCount ||
      balances.has(entry.accountIndex as number) ||
      !isAddress(entry.mint) ||
      (entry.owner !== undefined && !isAddress(entry.owner)) ||
      (entry.programId !== undefined && !isAddress(entry.programId)) ||
      !isRecord(entry.uiTokenAmount)
    )
      return undefined;
    const {amount, decimals} = entry.uiTokenAmount;
    if (
      typeof amount !== 'string' ||
      !/^(0|[1-9]\d{0,19})$/.test(amount) ||
      !Number.isInteger(decimals) ||
      (decimals as number) < 0 ||
      (decimals as number) > 255
    )
      return undefined;
    const value = BigInt(amount);
    if (
      value > BigInt('18446744073709551615') ||
      (decimalsByMint.has(entry.mint) &&
        decimalsByMint.get(entry.mint) !== decimals)
    )
      return undefined;
    decimalsByMint.set(entry.mint, decimals as number);
    balances.set(entry.accountIndex as number, {
      mint: entry.mint,
      decimals: decimals as number,
      amount: value,
      owner: entry.owner as string | undefined,
      programId: entry.programId as string | undefined,
    });
  }
  return balances;
}

function isLookupIndexes(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every(
      index =>
        typeof index === 'number' &&
        Number.isInteger(index) &&
        index >= 0 &&
        index <= 255,
    )
  );
}

function isLamports(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44)
    return false;
  try {
    return base58.decode(value).length === 32;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
