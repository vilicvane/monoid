import assert from 'node:assert/strict';
import {test} from 'node:test';

import {base58, base64} from '@scure/base';

const {loadSolanaTokenAccounts} = await import(
  '../.bld/app/@lib/solana-token-account.js'
);

const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const token2022Program = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const mint = new Uint8Array(32).fill(17);
const owner = new Uint8Array(32).fill(38);

function tokenAccount(state = 1) {
  const data = new Uint8Array(165);
  data.set(mint);
  data.set(owner, 32);
  data[108] = state;
  return data;
}

function tokenMint(decimals = 6, initialized = 1) {
  const data = new Uint8Array(82);
  data[44] = decimals;
  data[45] = initialized;
  return data;
}

function account(data, overrides) {
  return {
    owner: tokenProgram,
    executable: false,
    data: [base64.encode(data), 'base64'],
    ...overrides,
  };
}

function response(value, slot = 123) {
  return {context: {slot}, value};
}

test('reads initialized and frozen token accounts and initialized mints', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const records = [
    account(tokenAccount()),
    account(tokenAccount(2)),
    account(tokenMint()),
    account(tokenMint(255), {executable: undefined}),
  ];
  const addresses = ['AccountA', 'AccountB', 'MintA', 'MintB'];
  const result = await loadSolanaTokenAccounts(
    addresses,
    async (...args) => {
      calls.push(args);
      return response(records);
    },
    signal,
  );

  assert.deepEqual(calls, [
    [
      'getMultipleAccounts',
      [addresses, {encoding: 'base64', commitment: 'confirmed'}],
      signal,
    ],
  ]);
  assert.deepEqual(
    [...result],
    [
      ...addresses.slice(0, 2).map(address => [
        address,
        {
          kind: 'account',
          mint: base58.encode(mint),
          owner: base58.encode(owner),
        },
      ]),
      ['MintA', {kind: 'mint', decimals: 6}],
      ['MintB', {kind: 'mint', decimals: 255}],
    ],
  );
});

test('recognizes valid COption variants without requiring cleared unused payloads', async () => {
  const token = tokenAccount();
  const mintData = tokenMint();
  token.fill(255, 76, 108);
  token.fill(255, 113, 121);
  token.fill(255, 133);
  mintData.fill(255, 4, 36);
  mintData.fill(255, 50);
  const result = await loadSolanaTokenAccounts(['Token', 'Mint'], async () =>
    response([account(token), account(mintData)]),
  );
  assert.equal(result.size, 2);

  for (const offset of [72, 109, 129]) {
    token[offset] = 1;
  }
  for (const offset of [0, 46]) {
    mintData[offset] = 1;
  }
  const someResult = await loadSolanaTokenAccounts(
    ['Token', 'Mint'],
    async () => response([account(token), account(mintData)]),
  );
  assert.deepEqual(someResult, result);
});

test('does not invent token metadata for missing, foreign, executable or uninitialized accounts', async () => {
  const records = [
    null,
    account(tokenAccount(), {owner: token2022Program}),
    account(tokenAccount(), {owner: '11111111111111111111111111111111'}),
    account(tokenAccount(), {executable: true}),
    account(tokenAccount(0)),
    account(tokenMint(6, 0)),
    account(new Uint8Array(355)),
    account(new Uint8Array(166)),
    account(new Uint8Array(81)),
  ];
  const result = await loadSolanaTokenAccounts(
    records.map((_record, index) => `Account${index}`),
    async () => response(records),
  );
  assert.equal(result.size, 0);
});

test('does not recognize invalid state tags or any malformed COption tag', async () => {
  const records = [account(tokenAccount(3)), account(tokenMint(6, 2))];

  for (const [create, offsets] of [
    [tokenAccount, [72, 109, 129]],
    [tokenMint, [0, 46]],
  ]) {
    for (const offset of offsets) {
      for (const tag of [2, 256, 65536, 16777216]) {
        const data = create();
        new DataView(data.buffer).setUint32(offset, tag, true);
        records.push(account(data));
      }
    }
  }

  const result = await loadSolanaTokenAccounts(
    records.map((_record, index) => `Account${index}`),
    async () => response(records),
  );
  assert.equal(result.size, 0);
});

test('rejects malformed RPC envelopes and per-account fields', async () => {
  for (const value of [
    null,
    {},
    {context: {slot: 1}, value: {}},
    response([]),
    response([null, null]),
    {value: [null]},
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1'].map(slot =>
      response([null], slot),
    ),
    ...[
      undefined,
      {},
      {owner: 3},
      account(tokenMint(), {executable: 0}),
      account(tokenMint(), {data: {parsed: {}}}),
      account(tokenMint(), {data: [0, 'base64']}),
      account(tokenMint(), {data: ['', 'base58']}),
      account(tokenMint(), {data: ['', 'base64', 'extra']}),
    ].map(value => response([value])),
  ]) {
    await assert.rejects(
      loadSolanaTokenAccounts(['Mint'], async () => value),
      /Invalid Solana token account response/,
    );
  }
});

test('requires canonical base64 without whitespace, excess padding or stray bits', async () => {
  const encoded = base64.encode(tokenMint());

  for (const data of [
    ` ${encoded}`,
    `${encoded}\n`,
    `${encoded}==`,
    encoded.slice(0, -2),
    `${encoded.slice(0, -3)}B==`,
    'not-base64?',
  ]) {
    await assert.rejects(
      loadSolanaTokenAccounts(['Mint'], async () =>
        response([account(tokenMint(), {data: [data, 'base64']})]),
      ),
      /Invalid Solana token account encoding/,
    );
  }
});

test('deduplicates exact-case addresses and chunks in original order at 100 accounts', async () => {
  const addresses = Array.from(
    {length: 204},
    (_value, index) => `Account${index}`,
  );
  addresses.push('account0');
  const batches = [];
  const result = await loadSolanaTokenAccounts(
    [addresses[0], ...addresses, addresses[100]],
    async (_method, [batch]) => {
      batches.push(batch);
      return response(batch.map(() => account(tokenMint())));
    },
  );
  assert.deepEqual(
    batches.map(batch => batch.length),
    [100, 100, 5],
  );
  assert.deepEqual(batches.flat(), addresses);
  assert.deepEqual([...result.keys()], addresses);
});

test('empty input avoids RPC and cancellation stops before or after a batch', async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return response([]);
  };
  assert.equal((await loadSolanaTokenAccounts([], request)).size, 0);
  assert.equal(calls, 0);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loadSolanaTokenAccounts(['Mint'], request, controller.signal),
    {name: 'AbortError'},
  );
  assert.equal(calls, 0);

  const midRequest = new AbortController();
  await assert.rejects(
    loadSolanaTokenAccounts(
      Array.from({length: 101}, (_value, index) => `Account${index}`),
      async (_method, [batch], signal) => {
        calls++;
        assert.equal(signal, midRequest.signal);
        midRequest.abort();
        return response(batch.map(() => account(tokenMint())));
      },
      midRequest.signal,
    ),
    {name: 'AbortError'},
  );
  assert.equal(calls, 1);
});

test('preserves RPC errors without returning a partial set of accounts', async () => {
  const error = new Error('Solana RPC: rate limited');
  let calls = 0;
  await assert.rejects(
    loadSolanaTokenAccounts(
      Array.from({length: 101}, (_value, index) => `Account${index}`),
      async (_method, [batch]) => {
        if (++calls === 2) {
          throw error;
        }
        return response(batch.map(() => account(tokenMint())));
      },
    ),
    value => value === error,
  );
});
