import assert from 'node:assert/strict';
import {test} from 'node:test';

import {base58} from '@scure/base';

import {
  getSolanaTokenBalanceChanges,
  parseSolanaTransactionBalances,
} from '../.bld/app/@lib/solana-transaction-balances.js';

const address = byte => base58.encode(new Uint8Array(32).fill(byte));
const ALICE = address(1);
const BOB = address(2);
const ACCOUNT_A = address(3);
const ACCOUNT_B = address(4);
const MINT = address(5);
const OTHER_MINT = address(6);
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

function token(accountIndex, amount, owner = ALICE, overrides = {}) {
  return {
    accountIndex,
    mint: MINT,
    owner,
    programId: TOKEN,
    uiTokenAmount: {amount: String(amount), decimals: 6, uiAmount: null},
    ...overrides,
  };
}

function fixture(before = [], after = []) {
  return {
    version: 'legacy',
    transaction: {
      message: {accountKeys: [ALICE, BOB, ACCOUNT_A, ACCOUNT_B, TOKEN]},
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1000000000, 0, 2039280, 2039280, 1],
      postBalances: [999995000, 0, 2039280, 2039280, 1],
      preTokenBalances: before,
      postTokenBalances: after,
    },
  };
}

function changes(result) {
  return getSolanaTokenBalanceChanges(parseSolanaTransactionBalances(result));
}

test('legacy native balances include the fee and keep known empty tokens distinct from missing data', () => {
  const result = fixture();
  const original = structuredClone(result);
  const balances = parseSolanaTransactionBalances(result);
  assert.deepEqual(balances.native[0], {
    address: ALICE,
    before: 1000000000n,
    after: 999995000n,
  });
  assert.equal(balances.native.length, 5);
  assert.deepEqual(balances.tokens, []);
  assert.deepEqual(changes(result), []);
  assert.deepEqual(result, original);
});

test('transfers aggregate exact amounts by owner and mint rather than token account', () => {
  const result = fixture(
    [token(2, 1000), token(3, 25, BOB)],
    [token(2, 700), token(3, 325, BOB)],
  );
  assert.deepEqual(changes(result), [
    {
      owner: ALICE,
      account: undefined,
      mint: MINT,
      decimals: 6,
      programId: TOKEN,
      value: -300n,
    },
    {
      owner: BOB,
      account: undefined,
      mint: MINT,
      decimals: 6,
      programId: TOKEN,
      value: 300n,
    },
  ]);
  const parsed = parseSolanaTransactionBalances(result);
  assert.equal(parsed.tokens[0].address, ACCOUNT_A);
  assert.deepEqual(parsed.tokens[0].before, {amount: 1000n, owner: ALICE});
  assert.deepEqual(parsed.tokens[0].after, {amount: 700n, owner: ALICE});
});

test('a transfer between one owner’s accounts has no owner-level net change', () => {
  assert.deepEqual(
    changes(
      fixture([token(2, 1000), token(3, 25)], [token(2, 700), token(3, 325)]),
    ),
    [],
  );
});

test('changing token ownership attributes before and after independently', () => {
  const result = fixture([token(2, 100)], [token(2, 100, BOB)]);
  assert.deepEqual(
    changes(result).map(({owner, value}) => [owner, value]),
    [
      [ALICE, -100n],
      [BOB, 100n],
    ],
  );
});

test('created and closed token accounts preserve the absent side and yield complete changes', () => {
  const parsed = parseSolanaTransactionBalances(
    fixture([token(3, 20, BOB)], [token(2, 20)]),
  );
  const closed = parsed.tokens.find(({address}) => address === ACCOUNT_B);
  const created = parsed.tokens.find(({address}) => address === ACCOUNT_A);
  assert.equal(closed.after, undefined);
  assert.equal(created.before, undefined);
  assert.deepEqual(
    getSolanaTokenBalanceChanges(parsed).map(({owner, value}) => [
      owner,
      value,
    ]),
    [
      [BOB, -20n],
      [ALICE, 20n],
    ],
  );
});

test('recreating an account with another mint or token program does not merge distinct assets', () => {
  for (const replacement of [{mint: OTHER_MINT}, {programId: TOKEN_2022}]) {
    const parsed = parseSolanaTransactionBalances(
      fixture([token(2, 10)], [token(2, 20, ALICE, replacement)]),
    );
    assert.equal(parsed.tokens.length, 2);
    assert.equal(parsed.tokens[0].after, undefined);
    assert.equal(parsed.tokens[1].before, undefined);
    assert.deepEqual(
      getSolanaTokenBalanceChanges(parsed).map(({value}) => value),
      [-10n, 20n],
    );
  }
});

test('missing owners stay attributed to their token accounts and never inherit another side’s owner', () => {
  const unknown = {owner: undefined};
  const parsed = parseSolanaTransactionBalances(
    fixture(
      [token(2, 10, ALICE, unknown), token(3, 20, ALICE, unknown)],
      [token(2, 15, ALICE, unknown), token(3, 25, ALICE, unknown)],
    ),
  );
  assert.deepEqual(
    getSolanaTokenBalanceChanges(parsed).map(({owner, account, value}) => [
      owner,
      account,
      value,
    ]),
    [
      [undefined, ACCOUNT_A, 5n],
      [undefined, ACCOUNT_B, 5n],
    ],
  );
  const mixed = changes(
    fixture([token(2, 10, ALICE, unknown)], [token(2, 10, ALICE)]),
  );
  assert.deepEqual(
    mixed.map(({owner, account, value}) => [owner, account, value]),
    [
      [undefined, ACCOUNT_A, -10n],
      [ALICE, undefined, 10n],
    ],
  );
  const unchanged = parseSolanaTransactionBalances(
    fixture([token(2, 10, ALICE, unknown)], [token(2, 10, ALICE, unknown)]),
  );
  assert.deepEqual(getSolanaTokenBalanceChanges(unchanged), []);
  assert.equal(unchanged.tokens[0].before.owner, undefined);
});

test('raw token amounts retain full u64 precision and ignore rounded UI fields', () => {
  const result = fixture(
    [token(2, '18446744073709551614')],
    [token(2, '18446744073709551615')],
  );
  result.meta.preTokenBalances[0].uiTokenAmount.uiAmount = -500;
  result.meta.postTokenBalances[0].uiTokenAmount.uiAmount = 0;
  result.meta.postTokenBalances[0].uiTokenAmount.uiAmountString = 'incorrect';
  assert.equal(
    parseSolanaTransactionBalances(result).tokens[0].after.amount,
    18446744073709551615n,
  );
  assert.equal(changes(result)[0].value, 1n);
});

test('Token-2022 visible balances preserve the program without making extension claims', () => {
  const parsed = parseSolanaTransactionBalances(
    fixture(
      [token(2, 10, ALICE, {programId: TOKEN_2022})],
      [token(2, 15, ALICE, {programId: TOKEN_2022})],
    ),
  );
  assert.equal(parsed.tokens[0].programId, TOKEN_2022);
  assert.equal(getSolanaTokenBalanceChanges(parsed)[0].value, 5n);
  const absent = parseSolanaTransactionBalances(
    fixture(
      [token(2, 10, ALICE, {programId: undefined})],
      [token(2, 15, ALICE, {programId: undefined})],
    ),
  );
  assert.equal(absent.tokens[0].programId, undefined);
});

test('one absent or null token balance array makes only tokens unavailable', () => {
  for (const field of ['preTokenBalances', 'postTokenBalances']) {
    for (const missing of [undefined, null, {}]) {
      const result = fixture([token(2, 10)], [token(2, 20)]);
      result.meta[field] = missing;
      const parsed = parseSolanaTransactionBalances(result);
      assert.equal(parsed.tokens, undefined);
      assert.equal(parsed.native.length, 5);
    }
  }
});

test('unsafe lamports or mismatched native arrays do not suppress valid token balances', () => {
  for (const invalid of [
    Number.MAX_SAFE_INTEGER + 1,
    -1,
    1.5,
    '100',
    NaN,
    Infinity,
  ]) {
    const result = fixture([token(2, 10)], [token(2, 20)]);
    result.meta.preBalances[0] = invalid;
    const parsed = parseSolanaTransactionBalances(result);
    assert.equal(parsed.native, undefined);
    assert.equal(getSolanaTokenBalanceChanges(parsed)[0].value, 10n);
  }
  for (const field of ['preBalances', 'postBalances']) {
    const result = fixture();
    result.meta[field] = [0];
    assert.equal(parseSolanaTransactionBalances(result).native, undefined);
    result.meta[field] = undefined;
    assert.equal(parseSolanaTransactionBalances(result).native, undefined);
  }
});

test('duplicate indices, wrong indices, malformed token fields and inconsistent mint decimals are unavailable', () => {
  const mutations = [
    entry => ({...entry, accountIndex: -1}),
    entry => ({...entry, accountIndex: 5}),
    entry => ({...entry, accountIndex: 2.5}),
    entry => ({...entry, accountIndex: '2'}),
    entry => ({...entry, mint: 'not-an-address'}),
    entry => ({...entry, owner: null}),
    entry => ({...entry, programId: 'not-a-program'}),
    entry => ({...entry, uiTokenAmount: null}),
    ...['-1', '1.5', '01', '18446744073709551616', ''].map(amount => entry => ({
      ...entry,
      uiTokenAmount: {...entry.uiTokenAmount, amount},
    })),
    ...[-1, 256, 1.5, '6'].map(decimals => entry => ({
      ...entry,
      uiTokenAmount: {...entry.uiTokenAmount, decimals},
    })),
  ];
  for (const mutate of mutations) {
    const parsed = parseSolanaTransactionBalances(
      fixture([token(2, 10)], [mutate(token(2, 20))]),
    );
    assert.equal(parsed.tokens, undefined);
    assert.equal(parsed.native.length, 5);
  }
  assert.equal(
    parseSolanaTransactionBalances(fixture([token(2, 10), token(2, 10)], []))
      .tokens,
    undefined,
  );
  for (const index of [2, 3]) {
    assert.equal(
      parseSolanaTransactionBalances(
        fixture(
          [token(2, 10)],
          [
            token(index, 20, ALICE, {
              uiTokenAmount: {amount: '20', decimals: 9},
            }),
          ],
        ),
      ).tokens,
      undefined,
    );
  }
});

function versionedFixture() {
  const result = fixture(
    [token(3, 10), token(4, 20, BOB)],
    [token(3, 5), token(4, 25, BOB)],
  );
  result.version = 0;
  result.transaction.message = {
    accountKeys: [ALICE, BOB, TOKEN],
    addressTableLookups: [
      {accountKey: address(30), writableIndexes: [5], readonlyIndexes: [8]},
    ],
  };
  result.meta.loadedAddresses = {writable: [ACCOUNT_A], readonly: [ACCOUNT_B]};
  return result;
}

test('v0 resolves native and token indices as static, loaded writable, then loaded readonly', () => {
  const parsed = parseSolanaTransactionBalances(versionedFixture());
  assert.deepEqual(
    parsed.native.map(({address}) => address),
    [ALICE, BOB, TOKEN, ACCOUNT_A, ACCOUNT_B],
  );
  assert.deepEqual(
    parsed.tokens.map(({address}) => address),
    [ACCOUNT_A, ACCOUNT_B],
  );
  assert.deepEqual(
    getSolanaTokenBalanceChanges(parsed).map(({owner, value}) => [
      owner,
      value,
    ]),
    [
      [ALICE, -5n],
      [BOB, 5n],
    ],
  );
});

test('missing or malformed loaded addresses cannot silently misattribute v0 balances', () => {
  for (const loaded of [
    undefined,
    null,
    {},
    {writable: [], readonly: []},
    {writable: [ACCOUNT_A], readonly: ['invalid']},
    {writable: [ALICE], readonly: [ACCOUNT_B]},
  ]) {
    const result = versionedFixture();
    result.meta.loadedAddresses = loaded;
    assert.deepEqual(parseSolanaTransactionBalances(result), {});
  }
  const result = versionedFixture();
  delete result.transaction.message.addressTableLookups;
  assert.deepEqual(parseSolanaTransactionBalances(result), {});
});

test('malformed account keys and unusable results remain unavailable', () => {
  for (const keys of [[], null, ['bad'], [ALICE, ALICE], [{pubkey: ALICE}]]) {
    const result = fixture();
    result.transaction.message.accountKeys = keys;
    assert.deepEqual(parseSolanaTransactionBalances(result), {});
  }
  for (const result of [
    undefined,
    null,
    {},
    {meta: null},
    {transaction: {}, meta: {}},
  ]) {
    assert.deepEqual(parseSolanaTransactionBalances(result), {});
  }
});

test('failed execution still exposes actual balances including charged fees', () => {
  const result = fixture([token(2, 10)], [token(2, 10)]);
  result.meta.err = {InstructionError: [0, 'Custom']};
  const parsed = parseSolanaTransactionBalances(result);
  assert.equal(parsed.native[0].after - parsed.native[0].before, -5000n);
  assert.deepEqual(getSolanaTokenBalanceChanges(parsed), []);
});

test('case-distinct base58 owners remain separate identities', () => {
  const other = ALICE.replace('J', 'j');
  assert.notEqual(other, ALICE);
  assert.equal(base58.decode(other).length, 32);
  const result = fixture([token(2, 10, ALICE)], [token(2, 10, other)]);
  assert.deepEqual(
    changes(result).map(({owner, value}) => [owner, value]),
    [
      [ALICE, -10n],
      [other, 10n],
    ],
  );
});
