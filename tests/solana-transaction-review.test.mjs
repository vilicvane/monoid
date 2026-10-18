import assert from 'node:assert/strict';
import {test} from 'node:test';

import {base58, base64} from '@scure/base';

const {parseSolanaTransaction} = await import(
  '../.bld/app/@lib/solana-transaction.js'
);
const {reviewSolanaTransaction, loadSolanaTransactionReviews} = await import(
  '../.bld/app/@lib/solana-transaction-review.js'
);

const payer = new Uint8Array(32).fill(1);
const recipient = new Uint8Array(32).fill(2);
const systemProgram = new Uint8Array(32);
const computeProgram = base58.decode(
  'ComputeBudget111111111111111111111111111111',
);
const otherSigner = new Uint8Array(32).fill(3);
const tableOne = new Uint8Array(32).fill(11);
const tableTwo = new Uint8Array(32).fill(12);
const loadedOne = new Uint8Array(32).fill(21);
const loadedTwo = new Uint8Array(32).fill(22);
const loadedThree = new Uint8Array(32).fill(23);
const loadedFour = new Uint8Array(32).fill(24);
const lookupOwner = 'AddressLookupTab1e1111111111111111111111111';

function transferData(lamports = 10_000_000n) {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return data;
}

// Assemble the wire independently of the Kit codecs used by the implementation.
function transaction({
  version = 'legacy',
  header = [1, 0, 1],
  addresses = [payer, recipient, systemProgram],
  instructions = [{program: 2, accounts: [0, 1], data: transferData()}],
  lookups = [],
} = {}) {
  const message = [
    ...(version === 0 ? [0x80] : []),
    ...header,
    addresses.length,
    ...addresses.flatMap(address => [...address]),
    ...new Uint8Array(32).fill(4),
    instructions.length,
    ...instructions.flatMap(({program, accounts, data}) => [
      program,
      accounts.length,
      ...accounts,
      data.length,
      ...data,
    ]),
    ...(version === 0
      ? [
          lookups.length,
          ...lookups.flatMap(({address, writable, readonly}) => [
            ...address,
            writable.length,
            ...writable,
            readonly.length,
            ...readonly,
          ]),
        ]
      : []),
  ];
  return parseSolanaTransaction(
    base64.encode(
      Uint8Array.from([
        header[0],
        ...new Uint8Array(header[0] * 64),
        ...message,
      ]),
    ),
  );
}

function lookupAccount(
  addresses,
  {
    lastExtendedSlot = 0n,
    startIndex = 0,
    deactivationSlot = (1n << 64n) - 1n,
  } = {},
) {
  const data = new Uint8Array(56 + addresses.length * 32);
  new DataView(data.buffer).setUint32(0, 1, true);
  new DataView(data.buffer).setBigUint64(4, deactivationSlot, true);
  new DataView(data.buffer).setBigUint64(12, lastExtendedSlot, true);
  data[20] = startIndex;
  addresses.forEach((address, index) => data.set(address, 56 + index * 32));
  return {owner: lookupOwner, data: [base64.encode(data), 'base64']};
}

function lookupResponse(value, slot = 100) {
  return {context: {slot}, value};
}

function lookupTransaction() {
  return transaction({
    version: 0,
    addresses: [payer, systemProgram],
    instructions: [{program: 1, accounts: [0, 2], data: transferData()}],
    lookups: [{address: tableOne, writable: [0], readonly: []}],
  });
}

test('decodes SOL transfers with exact amounts and preserves original signing bytes', () => {
  const tx = transaction({
    header: [2, 1, 1],
    addresses: [payer, otherSigner, recipient, systemProgram],
    instructions: [
      {program: 3, accounts: [0, 2], data: transferData((1n << 64n) - 1n)},
    ],
  });
  const original = tx.messageBytes.slice();
  const review = reviewSolanaTransaction(tx);

  assert.equal(review.feePayer, base58.encode(payer));
  assert.deepEqual(
    review.accounts.map(({isSigner, isWritable}) => [isSigner, isWritable]),
    [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ],
  );
  assert.deepEqual(review.instructions[0].decoded, {
    kind: 'transfer',
    from: base58.encode(payer),
    to: base58.encode(recipient),
    lamports: (1n << 64n) - 1n,
  });
  assert.deepEqual(tx.messageBytes, original);
});

test('decodes compute unit settings and keeps unrecognized instructions opaque', () => {
  const limit = new Uint8Array(5);
  limit[0] = 2;
  new DataView(limit.buffer).setUint32(1, 400_000, true);
  const price = new Uint8Array(9);
  price[0] = 3;
  new DataView(price.buffer).setBigUint64(1, 123_456n, true);
  const raw = Uint8Array.of(1, 2, 255);
  const tx = transaction({
    header: [1, 0, 2],
    addresses: [payer, computeProgram, otherSigner],
    instructions: [
      {program: 1, accounts: [], data: limit},
      {program: 1, accounts: [], data: price},
      {program: 2, accounts: [0], data: raw},
    ],
  });
  const review = reviewSolanaTransaction(tx);

  assert.deepEqual(
    review.instructions.map(instruction => instruction.decoded),
    [
      {kind: 'compute-unit-limit', units: 400_000},
      {kind: 'compute-unit-price', microLamports: 123_456n},
      {kind: 'unknown'},
    ],
  );
  assert.deepEqual(review.instructions[2].data, raw);
  assert.deepEqual(review.instructions[2].accounts, [review.accounts[0]]);
});

test('never labels an instruction with unsupported data or account roles as a transfer', () => {
  for (const options of [
    {header: [1, 0, 2]},
    {instructions: [{program: 2, accounts: [1, 0], data: transferData()}]},
    {
      instructions: [
        {program: 2, accounts: [0, 1], data: [...transferData(), 0]},
      ],
    },
  ]) {
    const review = reviewSolanaTransaction(transaction(options));
    assert.deepEqual(review.instructions[0].decoded, {kind: 'unknown'});
  }
});

test('resolves all writable lookup addresses before all readonly addresses', () => {
  const tx = transaction({
    version: 0,
    addresses: [payer, systemProgram],
    instructions: [{program: 1, accounts: [0, 3], data: transferData()}],
    lookups: [
      {address: tableOne, writable: [1], readonly: [0]},
      {address: tableTwo, writable: [0], readonly: [1]},
    ],
  });
  const review = reviewSolanaTransaction(
    tx,
    new Map([
      [
        base58.encode(tableOne),
        [base58.encode(loadedOne), base58.encode(loadedTwo)],
      ],
      [
        base58.encode(tableTwo),
        [base58.encode(loadedThree), base58.encode(loadedFour)],
      ],
    ]),
  );

  assert.deepEqual(
    review.accounts.map(account => account.address),
    [payer, systemProgram, loadedTwo, loadedThree, loadedOne, loadedFour].map(
      base58.encode,
    ),
  );
  assert.deepEqual(
    review.accounts.slice(2).map(account => account.isWritable),
    [true, true, false, false],
  );
  assert.equal(review.instructions[0].decoded.to, base58.encode(loadedThree));
});

test('rejects unresolved, out-of-range and duplicate loaded accounts', () => {
  const tx = lookupTransaction();
  assert.throws(() => reviewSolanaTransaction(tx), /Could not resolve/);
  assert.throws(
    () => reviewSolanaTransaction(tx, new Map([[base58.encode(tableOne), []]])),
    /index is invalid/,
  );
  assert.throws(
    () =>
      reviewSolanaTransaction(
        tx,
        new Map([[base58.encode(tableOne), [base58.encode(payer)]]]),
      ),
    /duplicate accounts/,
  );
});

test('loads a shared lookup table once for the whole batch and preserves transaction order', async () => {
  const calls = [];
  const tx = lookupTransaction();
  const reviews = await loadSolanaTransactionReviews(
    [tx, transaction(), tx],
    async (...args) => {
      calls.push(args);
      return lookupResponse([lookupAccount([recipient])]);
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), [
    'getMultipleAccounts',
    [[base58.encode(tableOne)], {encoding: 'base64', commitment: 'confirmed'}],
  ]);
  assert.equal(reviews.length, 3);
  assert.equal(reviews[0].instructions[0].decoded.to, base58.encode(recipient));
  assert.deepEqual(reviews[0], reviews[2]);
  assert.equal(reviews[1].accounts.length, 3);
});

test('does not access RPC for legacy or v0 without lookup tables', async () => {
  const reviews = await loadSolanaTransactionReviews(
    [transaction(), transaction({version: 0})],
    () => {
      throw new Error('RPC must not be called');
    },
  );
  assert.equal(reviews.length, 2);
});

test('rejects missing or invalid lookup table accounts', async () => {
  const valid = lookupAccount([recipient]);
  const invalidData = base64.decode(valid.data[0]);
  invalidData[0] = 0;
  for (const response of [
    {value: []},
    {value: [null]},
    {value: [{...valid, owner: base58.encode(systemProgram)}]},
    {value: [{...valid, data: [valid.data[0], 'base58']}]},
    {value: [{...valid, data: [base64.encode(invalidData), 'base64']}]},
    {value: [{...valid, data: [base64.encode(new Uint8Array(55)), 'base64']}]},
    {value: [{...valid, data: [base64.encode(new Uint8Array(57)), 'base64']}]},
  ]) {
    await assert.rejects(
      loadSolanaTransactionReviews([lookupTransaction()], async () => ({
        context: {slot: 100},
        ...response,
      })),
      /lookup table/,
    );
  }
});

test('honors cancellation before requests and before returning fetched data', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loadSolanaTransactionReviews(
      [transaction()],
      () => {
        throw new Error('RPC must not be called');
      },
      controller.signal,
    ),
    {name: 'AbortError'},
  );

  const duringRequest = new AbortController();
  await assert.rejects(
    loadSolanaTransactionReviews(
      [lookupTransaction()],
      async (_method, _params, signal) => {
        assert.equal(signal, duringRequest.signal);
        duringRequest.abort();
        return lookupResponse([lookupAccount([recipient])]);
      },
      duringRequest.signal,
    ),
    {name: 'AbortError'},
  );
});

test('propagates RPC failures instead of reviewing unresolved accounts', async () => {
  await assert.rejects(
    loadSolanaTransactionReviews([lookupTransaction()], async () => {
      throw new Error('RPC is unavailable');
    }),
    /RPC is unavailable/,
  );
});

test('does not expose addresses appended in the current context slot', async () => {
  const newlyExtended = lookupAccount([recipient], {lastExtendedSlot: 100n});
  await assert.rejects(
    loadSolanaTransactionReviews([lookupTransaction()], async () =>
      lookupResponse([newlyExtended], 100),
    ),
    /lookup table index is invalid/,
  );

  const [review] = await loadSolanaTransactionReviews(
    [lookupTransaction()],
    async () => lookupResponse([newlyExtended], 101),
  );
  assert.equal(review.instructions[0].decoded.to, base58.encode(recipient));

  const previouslyActive = lookupAccount([recipient, loadedOne], {
    lastExtendedSlot: 100n,
    startIndex: 1,
  });
  const [sameSlotReview] = await loadSolanaTransactionReviews(
    [lookupTransaction()],
    async () => lookupResponse([previouslyActive], 100),
  );
  assert.equal(
    sameSlotReview.instructions[0].decoded.to,
    base58.encode(recipient),
  );
});

test('explicitly rejects deactivating tables and invalid slot metadata', async () => {
  await assert.rejects(
    loadSolanaTransactionReviews([lookupTransaction()], async () =>
      lookupResponse([lookupAccount([recipient], {deactivationSlot: 99n})]),
    ),
    /Deactivating Solana address lookup tables are not supported/,
  );

  for (const response of [
    {value: [lookupAccount([recipient])]},
    lookupResponse([lookupAccount([recipient])], -1),
    lookupResponse([lookupAccount([recipient], {lastExtendedSlot: 101n})], 100),
    lookupResponse([lookupAccount([recipient], {startIndex: 2})]),
  ]) {
    await assert.rejects(
      loadSolanaTransactionReviews([lookupTransaction()], async () => response),
      /lookup table/,
    );
  }
});
