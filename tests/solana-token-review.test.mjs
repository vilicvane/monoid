import assert from 'node:assert/strict';
import {test} from 'node:test';

import {base58, base64} from '@scure/base';
import {getProgramDerivedAddress} from '@solana/addresses';

const {loadSolanaTokenReviews} = await import(
  '../.bld/app/@lib/solana-token-review.js'
);
const {
  SOLANA_TOKEN_PROGRAM,
  SOLANA_ASSOCIATED_TOKEN_PROGRAM,
  decodeSolanaTokenInstruction,
} = await import('../.bld/app/@lib/solana-token-instruction.js');
const {parseSolanaTransaction} = await import(
  '../.bld/app/@lib/solana-transaction.js'
);
const {loadSolanaTransactionReviews} = await import(
  '../.bld/app/@lib/solana-transaction-review.js'
);

const address = byte => base58.encode(new Uint8Array(32).fill(byte));
const authority = address(1);
const source = address(2);
const destination = address(3);
const mint = address(4);
const otherMint = address(5);
const owner = address(6);
const delegate = address(7);
const unknownProgram = address(8);
const [associatedAccount] = await getProgramDerivedAddress({
  programAddress: SOLANA_ASSOCIATED_TOKEN_PROGRAM,
  seeds: [
    base58.decode(owner),
    base58.decode(SOLANA_TOKEN_PROGRAM),
    base58.decode(mint),
  ],
});

function account(address, isWritable = false, isSigner = false) {
  return {address, isWritable, isSigner};
}

function amountData(tag, amount = 1_234_567n, decimals = 6) {
  const checked = tag === 12 || tag === 13;
  const data = new Uint8Array(checked ? 10 : 9);
  data[0] = tag;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  if (checked) data[9] = decimals;
  return data;
}

function instruction(tag = 3, options = {}) {
  const checked = tag === 12 || tag === 13;
  const transfer = tag === 3 || tag === 12;
  const data =
    tag === 5
      ? Uint8Array.of(5)
      : amountData(tag, options.amount, options.decimals);
  const accounts = [
    account(options.source ?? source, true),
    ...(checked ? [account(options.mint ?? mint)] : []),
    ...(tag === 5
      ? []
      : [
          account(
            transfer ? (options.destination ?? destination) : delegate,
            transfer,
          ),
        ]),
    account(authority, false, true),
  ];

  return {
    programAddress: SOLANA_TOKEN_PROGRAM,
    accounts,
    data,
    decoded: decodeSolanaTokenInstruction(SOLANA_TOKEN_PROGRAM, accounts, data),
  };
}

function createInstruction() {
  const accounts = [
    account(authority, true, true),
    account(associatedAccount, true),
    account(owner),
    account(mint),
    account('11111111111111111111111111111111'),
    account(SOLANA_TOKEN_PROGRAM),
  ];
  const data = Uint8Array.of(1);

  return {
    programAddress: SOLANA_ASSOCIATED_TOKEN_PROGRAM,
    accounts,
    data,
    decoded: decodeSolanaTokenInstruction(
      SOLANA_ASSOCIATED_TOKEN_PROGRAM,
      accounts,
      data,
    ),
  };
}

function unknownInstruction(address, isWritable = true) {
  return {
    programAddress: unknownProgram,
    accounts: [account(address, isWritable)],
    data: Uint8Array.of(255),
    decoded: {kind: 'unknown'},
  };
}

function review(...instructions) {
  return {feePayer: authority, accounts: [], instructions};
}

function rpcAccount(data) {
  return {
    owner: SOLANA_TOKEN_PROGRAM,
    executable: false,
    data: [base64.encode(data), 'base64'],
  };
}

function tokenAccount(mintAddress = mint, ownerAddress = owner) {
  const data = new Uint8Array(165);
  data.set(base58.decode(mintAddress));
  data.set(base58.decode(ownerAddress), 32);
  data[108] = 1;
  return rpcAccount(data);
}

function tokenMint(decimals = 6) {
  const data = new Uint8Array(82);
  data[44] = decimals;
  data[45] = 1;
  return rpcAccount(data);
}

function rpc(
  records = new Map([
    [source, tokenAccount()],
    [destination, tokenAccount()],
    [mint, tokenMint()],
  ]),
) {
  const calls = [];
  const request = async (method, params, signal) => {
    calls.push({method, params, signal});
    assert.equal(method, 'getMultipleAccounts');
    return {
      context: {slot: 123},
      value: params[0].map(address => records.get(address) ?? null),
    };
  };
  return {calls, request};
}

test('hydrates an actual parsed checked transaction without changing any signed bytes', async () => {
  const addresses = [
    authority,
    source,
    destination,
    mint,
    SOLANA_TOKEN_PROGRAM,
  ];
  const data = amountData(12);
  const message = Uint8Array.from([
    1,
    0,
    2,
    addresses.length,
    ...addresses.flatMap(address => [...base58.decode(address)]),
    ...new Uint8Array(32).fill(9),
    1,
    4,
    4,
    1,
    3,
    2,
    0,
    data.length,
    ...data,
  ]);
  const transaction = parseSolanaTransaction(
    base64.encode(Uint8Array.from([1, ...new Uint8Array(64), ...message])),
  );
  const original = transaction.bytes.slice();
  const {request, calls} = rpc();
  const [result] = await loadSolanaTransactionReviews([transaction], request);

  assert.deepEqual(result.instructions[0].decoded, {
    kind: 'token-transfer',
    source,
    destination,
    authority,
    amount: 1_234_567n,
    mint,
    decimals: 6,
  });
  assert.deepEqual(result.instructions[0].token, {
    mint,
    decimals: 6,
    warning: undefined,
    source: {owner, associated: false},
    destination: {owner, associated: false},
  });
  assert.deepEqual(transaction.bytes, original);
  assert.deepEqual(result.instructions[0].data, data);
  assert.equal(calls.length, 1);
});

test('hydrates unchecked transfer, approval, and revoke from the source token account', async () => {
  const items = [instruction(3), instruction(4), instruction(5)];
  const original = structuredClone(items);
  const {request, calls} = rpc();
  const [result] = await loadSolanaTokenReviews([review(...items)], request);

  for (const item of result.instructions) {
    assert.deepEqual(item.token, {
      mint,
      decimals: 6,
      warning: undefined,
      source: {owner, associated: false},
      ...(item.decoded.kind === 'token-transfer'
        ? {destination: {owner, associated: false}}
        : {}),
    });
  }
  assert.deepEqual(items, original);
  assert.equal(calls.length, 2);
  assert.deepEqual(new Set(calls[0].params[0]), new Set([source, destination]));
  assert.deepEqual(calls[1].params[0], [mint]);
});

test('never overrides signed checked precision with the RPC mint precision', async () => {
  for (const tag of [12, 13]) {
    const item = instruction(tag, {decimals: 0});
    const {request} = rpc();
    const [result] = await loadSolanaTokenReviews([review(item)], request);
    const hydrated = result.instructions[0];

    assert.equal(hydrated.token.mint, mint);
    assert.equal(hydrated.token.decimals, 0);
    assert.equal(hydrated.decoded.decimals, 0);
    assert.match(hydrated.token.warning, /decimals do not match/);
  }
});

test('flags on-chain source mint mismatches without replacing the signed mint', async () => {
  const {request} = rpc(
    new Map([
      [source, tokenAccount(otherMint)],
      [mint, tokenMint()],
      [otherMint, tokenMint(9)],
    ]),
  );
  const [result] = await loadSolanaTokenReviews(
    [review(instruction(13))],
    request,
  );

  assert.equal(result.instructions[0].token.mint, mint);
  assert.equal(result.instructions[0].token.decimals, 6);
  assert.equal(result.instructions[0].decoded.mint, mint);
  assert.match(result.instructions[0].token.warning, /mint does not match/);
  assert.equal(result.instructions[0].token.source, undefined);
});

test('flags destination mint mismatches instead of presenting a normal transfer', async () => {
  const {request} = rpc(
    new Map([
      [source, tokenAccount()],
      [destination, tokenAccount(otherMint)],
      [mint, tokenMint()],
      [otherMint, tokenMint(9)],
    ]),
  );
  const [result] = await loadSolanaTokenReviews(
    [review(instruction())],
    request,
  );

  assert.equal(result.instructions[0].token.mint, mint);
  assert.match(result.instructions[0].token.warning, /different tokens/);
  assert.equal(result.instructions[0].token.destination, undefined);
});

test('unavailable RPC preserves checked fields and leaves unchecked values in base units', async () => {
  const request = async () => {
    throw new Error('offline');
  };
  const items = [instruction(), instruction(12)];
  const [result] = await loadSolanaTokenReviews([review(...items)], request);

  assert.equal(result.instructions[0].token.mint, undefined);
  assert.equal(result.instructions[0].token.decimals, undefined);
  assert.equal(result.instructions[1].token.mint, mint);
  assert.equal(result.instructions[1].token.decimals, 6);
  result.instructions.forEach((item, index) => {
    assert.deepEqual(item.decoded, items[index].decoded);
    assert.match(item.token.warning, /unavailable/);
    assert.equal(item.token.source, undefined);
    assert.equal(item.token.destination, undefined);
  });
});

test('failure of the second RPC retains known mint identity without inventing precision', async () => {
  const {request} = rpc();
  let count = 0;
  const [result] = await loadSolanaTokenReviews(
    [review(instruction())],
    async (...args) => {
      if (++count === 2) throw new Error('mint lookup failed');
      return request(...args);
    },
  );

  assert.equal(result.instructions[0].token.mint, mint);
  assert.equal(result.instructions[0].token.decimals, undefined);
  assert.match(result.instructions[0].token.warning, /unavailable/);
});

test('abort propagates instead of becoming supplemental-data fallback', async () => {
  for (const during of [false, true]) {
    const controller = new AbortController();
    const reason = new Error('review dismissed');
    if (!during) controller.abort(reason);
    let calls = 0;

    await assert.rejects(
      loadSolanaTokenReviews(
        [review(instruction())],
        async () => {
          calls++;
          controller.abort(reason);
          throw new Error('transport cancelled');
        },
        controller.signal,
      ),
      error => error === reason,
    );
    assert.equal(calls, during ? 1 : 0);
  }
});

test('ATA creation establishes only later instructions within the same transaction', async () => {
  const {request} = rpc(
    new Map([
      [mint, tokenMint()],
      [destination, tokenAccount()],
    ]),
  );
  const before = instruction(3, {source: associatedAccount});
  const after = instruction(3, {source: associatedAccount});
  const [result] = await loadSolanaTokenReviews(
    [review(before, createInstruction(), after)],
    request,
  );

  assert.equal(result.instructions[0].token.mint, undefined);
  assert.equal(result.instructions[0].token.decimals, undefined);
  assert.match(result.instructions[0].token.warning, /unavailable/);
  assert.deepEqual(result.instructions[2].token, {
    mint,
    decimals: 6,
    warning: undefined,
    source: {owner, associated: true},
    destination: {owner, associated: false},
  });
  assert.equal(result.instructions[1].token.accountExists, undefined);
});

test('separate batch transactions never inherit an ATA creation execution order', async () => {
  for (const reverse of [false, true]) {
    const {request} = rpc(
      new Map([
        [mint, tokenMint()],
        [destination, tokenAccount()],
      ]),
    );
    const create = review(createInstruction());
    const transfer = review(instruction(3, {source: associatedAccount}));
    const result = await loadSolanaTokenReviews(
      reverse ? [transfer, create] : [create, transfer],
      request,
    );
    const token = result[reverse ? 0 : 1].instructions[0].token;

    assert.equal(token.mint, undefined);
    assert.equal(token.decimals, undefined);
    assert.match(token.warning, /unavailable/);
    assert.equal(token.source, undefined);
  }
});

test('unknown writable instructions prevent inference from potentially stale source state', async () => {
  for (const separate of [false, true]) {
    const {request} = rpc();
    const transfer = instruction();
    const unknown = unknownInstruction(source);
    const reviews = separate
      ? [review(unknown), review(transfer)]
      : [review(unknown, transfer)];
    const result = await loadSolanaTokenReviews(reviews, request);
    const token = result.at(-1).instructions.at(-1).token;

    assert.equal(token.mint, undefined);
    assert.equal(token.decimals, undefined);
    assert.match(token.warning, /unavailable/);
    assert.equal(token.source, undefined);
  }
});

test('unknown writable mint prevents inferred precision while readonly access does not', async () => {
  for (const isWritable of [false, true]) {
    const {request} = rpc();
    const [result] = await loadSolanaTokenReviews(
      [review(unknownInstruction(mint, isWritable), instruction())],
      request,
    );

    assert.equal(result.instructions[1].token.mint, mint);
    assert.equal(
      result.instructions[1].token.decimals,
      isWritable ? undefined : 6,
    );
    assert.equal(Boolean(result.instructions[1].token.warning), isWritable);
  }
});

test('unknown writable account prevents ATA assumptions from hiding mutations', async () => {
  const {request} = rpc(
    new Map([
      [mint, tokenMint()],
      [destination, tokenAccount()],
    ]),
  );
  const [result] = await loadSolanaTokenReviews(
    [
      review(
        createInstruction(),
        unknownInstruction(associatedAccount),
        instruction(3, {source: associatedAccount}),
      ),
    ],
    request,
  );

  assert.equal(result.instructions[2].token.mint, undefined);
  assert.equal(result.instructions[2].token.decimals, undefined);
  assert.match(result.instructions[2].token.warning, /unavailable/);
  assert.equal(result.instructions[2].token.source, undefined);
  assert.equal(result.instructions[0].token.accountExists, undefined);
});

test('identifies associated token accounts by their owner rather than signing authority', async () => {
  const {request} = rpc(
    new Map([
      [associatedAccount, tokenAccount()],
      [mint, tokenMint()],
    ]),
  );
  const [result] = await loadSolanaTokenReviews(
    [
      review(
        instruction(12, {
          source: associatedAccount,
          destination: associatedAccount,
        }),
      ),
    ],
    request,
  );
  const item = result.instructions[0];

  assert.equal(item.decoded.authority, authority);
  assert.notEqual(authority, owner);
  assert.deepEqual(item.token.source, {owner, associated: true});
  assert.deepEqual(item.token.destination, {owner, associated: true});
});

test('only a matching on-chain account proves an idempotent create is already satisfied', async () => {
  for (const [existing, accountExists] of [
    [undefined, undefined],
    [tokenAccount(otherMint), undefined],
    [tokenAccount(mint, authority), undefined],
    [tokenAccount(), true],
  ]) {
    const {request, calls} = rpc(
      new Map([
        [associatedAccount, existing],
        [mint, tokenMint()],
      ]),
    );
    const [result] = await loadSolanaTokenReviews(
      [review(createInstruction())],
      request,
    );
    const token = result.instructions[0].token;

    assert.ok(calls[0].params[0].includes(associatedAccount));
    assert.equal(token.accountExists, accountExists);
  }
});

test('ATA creation never replaces an on-chain owner or mint mismatch', async () => {
  for (const existing of [
    tokenAccount(otherMint),
    tokenAccount(mint, authority),
  ]) {
    const {request} = rpc(
      new Map([
        [associatedAccount, existing],
        [mint, tokenMint()],
        [otherMint, tokenMint()],
      ]),
    );
    const [result] = await loadSolanaTokenReviews(
      [
        review(
          createInstruction(),
          instruction(13, {source: associatedAccount}),
        ),
      ],
      request,
    );
    const [create, approval] = result.instructions;

    assert.equal(create.token.accountExists, undefined);
    assert.match(create.token.warning, /does not match/);
    assert.notDeepEqual(approval.token.source, {owner, associated: true});
  }
});

test('same-transaction creation resolves later destinations without inventing prior existence', async () => {
  const {request} = rpc(new Map([[mint, tokenMint()]]));
  const [result] = await loadSolanaTokenReviews(
    [
      review(
        createInstruction(),
        createInstruction(),
        instruction(12, {
          source: associatedAccount,
          destination: associatedAccount,
        }),
      ),
    ],
    request,
  );

  assert.equal(result.instructions[0].token.accountExists, undefined);
  assert.equal(result.instructions[1].token.accountExists, undefined);
  assert.deepEqual(result.instructions[2].token.destination, {
    owner,
    associated: true,
  });
});

test('unknown writable accounts invalidate on-chain existence and destination ownership', async () => {
  const {request} = rpc(
    new Map([
      [associatedAccount, tokenAccount()],
      [source, tokenAccount()],
      [mint, tokenMint()],
    ]),
  );
  const [result] = await loadSolanaTokenReviews(
    [
      review(
        createInstruction(),
        unknownInstruction(associatedAccount),
        instruction(12, {destination: associatedAccount}),
      ),
    ],
    request,
  );

  assert.equal(result.instructions[0].token.accountExists, undefined);
  assert.equal(result.instructions[2].token.destination, undefined);
  assert.match(result.instructions[2].token.warning, /unavailable/);
});

test('non-token reviews perform no additional RPC and preserve their instruction objects', async () => {
  const item = unknownInstruction(source);
  const input = review(item);
  const [result] = await loadSolanaTokenReviews([input], async () => {
    assert.fail('unexpected supplemental RPC');
  });

  assert.equal(result, input);
  assert.equal(result.instructions[0], item);
});
