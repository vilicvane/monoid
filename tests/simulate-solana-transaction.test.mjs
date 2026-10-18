import assert from 'node:assert/strict';
import {createPrivateKey, createPublicKey, sign} from 'node:crypto';
import {test} from 'node:test';

import {base64} from '@scure/base';

import {simulateSolanaTransaction} from '../.bld/app/@lib/simulate-solana-transaction.js';
import {parseSolanaTransaction} from '../.bld/app/@lib/solana-transaction.js';

function signingKey(byte) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, byte),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey)
    .export({format: 'der', type: 'spki'})
    .subarray(-32);
  return {privateKey, publicKey};
}

const payer = signingKey(1);
const otherSigner = signingKey(2);

function transaction(version = 'legacy', partial = false) {
  const message = Buffer.from([
    ...(version === 0 ? [0x80] : []),
    2,
    0,
    0,
    2,
    ...payer.publicKey,
    ...otherSigner.publicKey,
    ...Buffer.alloc(32, 3),
    0,
    ...(version === 0 ? [0] : []),
  ]);
  const bytes = Buffer.concat([
    Buffer.from([2]),
    Buffer.alloc(64),
    partial ? sign(null, message, otherSigner.privateKey) : Buffer.alloc(64),
    message,
  ]);
  return parseSolanaTransaction(bytes.toString('base64'));
}

function simulation(value = {}, slot = 123) {
  return {
    context: {slot},
    value: {err: null, logs: [], unitsConsumed: 1234, ...value},
  };
}

function fee(value = 5000, slot = 123) {
  return {context: {slot}, value};
}

function request(...responses) {
  const simulationResponse = responses.length ? responses[0] : simulation();
  const feeResponse = responses.length > 1 ? responses[1] : fee();
  return async method => {
    if (method === 'simulateTransaction') return simulationResponse;
    assert.equal(method, 'getFeeForMessage');
    return feeResponse;
  };
}

test('simulates exact legacy/v0 unsigned and partially signed wire bytes without changing the message', async () => {
  for (const version of ['legacy', 0]) {
    for (const partial of [false, true]) {
      const tx = transaction(version, partial);
      const original = tx.bytes.slice();
      const originalMessage = tx.messageBytes.slice();
      const calls = [];
      const signal = new AbortController().signal;
      const result = await simulateSolanaTransaction(
        tx,
        async (...args) => {
          calls.push(args);
          return args[0] === 'simulateTransaction' ? simulation() : fee();
        },
        signal,
      );

      assert.deepEqual(calls, [
        [
          'simulateTransaction',
          [
            base64.encode(original),
            {
              encoding: 'base64',
              sigVerify: false,
              replaceRecentBlockhash: false,
              commitment: 'confirmed',
            },
          ],
          signal,
        ],
        [
          'getFeeForMessage',
          [base64.encode(originalMessage), {commitment: 'confirmed'}],
          signal,
        ],
      ]);
      assert.deepEqual(tx.bytes, original);
      assert.deepEqual(tx.messageBytes, originalMessage);
      assert.equal(
        tx.signatures[0].some(byte => byte !== 0),
        false,
      );
      assert.equal(
        tx.signatures[1].some(byte => byte !== 0),
        partial,
      );
      assert.deepEqual(result, {
        status: 'succeeded',
        fee: 5000n,
        logs: [],
        unitsConsumed: 1234,
        slot: 123,
      });
    }
  }
});

test('starts simulation and fee lookup concurrently', async () => {
  const calls = [];
  let resolveSimulation;
  let resolveFee;
  const pending = simulateSolanaTransaction(transaction(), method => {
    calls.push(method);
    return new Promise(resolve => {
      if (method === 'simulateTransaction') resolveSimulation = resolve;
      else resolveFee = resolve;
    });
  });

  assert.deepEqual(calls, ['simulateTransaction', 'getFeeForMessage']);
  resolveFee(fee());
  resolveSimulation(simulation());
  assert.equal((await pending).status, 'succeeded');
});

test('prefers valid simulation fees including zero over the separate estimate', async () => {
  for (const amount of [0, 7000, Number.MAX_SAFE_INTEGER]) {
    const result = await simulateSolanaTransaction(
      transaction(),
      request(simulation({fee: amount}), fee(5000)),
    );
    assert.equal(result.fee, BigInt(amount));
    assert.equal(result.feeError, undefined);
  }
});

test('uses message fees when the simulation omits its fee or returns null', async () => {
  for (const value of [{}, {fee: null}]) {
    const result = await simulateSolanaTransaction(
      transaction(),
      request(simulation(value)),
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(result.fee, 5000n);
    assert.equal(result.feeError, undefined);
  }
});

test('describes execution failures with one-based instruction positions and custom codes', async () => {
  const cases = [
    ['InsufficientFundsForFee', 'Insufficient SOL to pay the transaction fee.'],
    [
      {InstructionError: [0, 'InsufficientFunds']},
      'Instruction 1: Insufficient funds.',
    ],
    [
      {InstructionError: [3, {Custom: 0}]},
      'Instruction 4: Custom program error 0.',
    ],
    [
      {InstructionError: [2, {Custom: 6001}]},
      'Instruction 3: Custom program error 6001.',
    ],
    [
      {InsufficientFundsForRent: {account_index: 2}},
      'Insufficient SOL for account rent (account 3).',
    ],
  ];
  for (const [err, error] of cases) {
    const logs = ['Program invoked', 'Program failed'];
    const result = await simulateSolanaTransaction(
      transaction(),
      request(simulation({err, logs, unitsConsumed: 0, fee: 5000})),
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.error, error);
    assert.equal(result.fee, 5000n);
    assert.equal(result.unitsConsumed, 0);
    assert.deepEqual(result.logs, logs);
  }
});

test('does not interpret BlockhashNotFound as proof that a transaction expired', async () => {
  const result = await simulateSolanaTransaction(
    transaction(),
    request(simulation({err: 'BlockhashNotFound'}), fee(null)),
  );
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error, 'The transaction blockhash is unavailable.');
  assert.doesNotMatch(result.error, /expired/i);
  assert.equal(result.fee, undefined);
  assert.match(result.feeError, /unavailable/);
});

test('unknown execution and RPC errors keep useful original messages or JSON', async () => {
  for (const err of [
    'FutureFailure',
    {FutureFailure: {reason: 'specific reason'}},
    {message: 'Specific program error'},
  ]) {
    const result = await simulateSolanaTransaction(
      transaction(),
      request(simulation({err})),
    );
    assert.equal(result.status, 'failed');
    assert.equal(
      result.error,
      typeof err === 'string' ? err : (err.message ?? JSON.stringify(err)),
    );
  }

  for (const thrown of [
    new Error('Solana RPC: node is behind'),
    'request timed out',
    {code: -32005, message: 'Node unhealthy'},
    {code: -32099, detail: 'Additional context'},
  ]) {
    const result = await simulateSolanaTransaction(
      transaction(),
      async method => {
        if (method === 'simulateTransaction') throw thrown;
        return fee();
      },
    );
    assert.equal(result.status, 'unavailable');
    assert.equal(
      result.error,
      thrown.message ??
        (typeof thrown === 'string' ? thrown : JSON.stringify(thrown)),
    );
    assert.equal(result.fee, 5000n);
  }
});

test('a fee RPC outage does not discard successful simulation', async () => {
  const result = await simulateSolanaTransaction(
    transaction(),
    async method => {
      if (method === 'getFeeForMessage') throw new Error('Fee RPC unavailable');
      return simulation();
    },
  );

  assert.equal(result.status, 'succeeded');
  assert.equal(result.fee, undefined);
  assert.equal(result.feeError, 'Fee RPC unavailable');
  assert.equal(result.error, undefined);
});

test('a valid simulation fee remains usable when the fallback RPC fails', async () => {
  const result = await simulateSolanaTransaction(
    transaction(),
    async method => {
      if (method === 'getFeeForMessage')
        throw new Error('Fallback RPC unavailable');
      return simulation({fee: 7000});
    },
  );

  assert.equal(result.status, 'succeeded');
  assert.equal(result.fee, 7000n);
});

test('absent, malformed, and empty err fields never become successful simulation', async () => {
  const values = [
    undefined,
    false,
    true,
    0,
    1,
    '',
    [],
    {},
    {InstructionError: []},
    {InstructionError: [0]},
    {InstructionError: [-1, 'Error']},
    {InstructionError: [256, 'Error']},
    {InstructionError: [0, null]},
    {InstructionError: [0, {Custom: -1}]},
    {InstructionError: [0, {Custom: 2 ** 32}]},
  ];
  for (const err of values) {
    const result = await simulateSolanaTransaction(
      transaction(),
      request(simulation({err})),
    );
    assert.equal(result.status, 'unavailable');
    assert.match(result.error, /Invalid.*simulation response/);
    assert.equal(result.fee, 5000n);
  }
});

test('malformed simulation envelopes, slots, logs, and consumed units are unavailable', async () => {
  const responses = [
    null,
    undefined,
    [],
    {},
    {context: {slot: 1}},
    {value: {err: null}},
    {context: {}, value: {err: null}},
    {context: {slot: 1}, value: null},
    simulation({logs: [1]}),
    simulation({logs: 'log'}),
  ];
  for (const number of [
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    Infinity,
    NaN,
    '123',
  ]) {
    responses.push(simulation({}, number), simulation({unitsConsumed: number}));
  }
  for (const response of responses) {
    const result = await simulateSolanaTransaction(
      transaction(),
      request(response),
    );
    assert.equal(result.status, 'unavailable');
    assert.match(result.error, /Invalid.*simulation response/);
    assert.equal(result.fee, 5000n);
  }
});

test('nullable and omitted optional simulation fields remain optional', async () => {
  for (const value of [
    {err: null},
    {err: null, logs: null, unitsConsumed: null, fee: null},
  ]) {
    const result = await simulateSolanaTransaction(
      transaction(),
      request({context: {slot: 0}, value}),
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(result.slot, 0);
    assert.equal(result.logs, undefined);
    assert.equal(result.unitsConsumed, undefined);
    assert.equal(result.fee, 5000n);
  }
});

test('null, missing, malformed, and unsafe fees never become zero or lose precision', async () => {
  const responses = [
    null,
    undefined,
    {},
    fee(null),
    {context: {slot: 1}},
    {value: 5000},
    fee(5000, -1),
  ];
  for (const value of [
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    Infinity,
    NaN,
    '5000',
    5000n,
  ])
    responses.push(fee(value));

  for (const response of responses) {
    const result = await simulateSolanaTransaction(
      transaction(),
      request(simulation(), response),
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(result.fee, undefined);
    assert.equal(typeof result.feeError, 'string');
  }
});

test('invalid optional simulation fees can fall back without discarding the execution result', async () => {
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '5000']) {
    const result = await simulateSolanaTransaction(
      transaction(),
      request(simulation({fee: value}), fee(6000)),
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(result.fee, 6000n);
  }
});

test('aborting before requests prevents all RPC and aborting in flight propagates the original reason', async () => {
  const controller = new AbortController();
  const reason = new Error('left transaction review');
  controller.abort(reason);
  await assert.rejects(
    simulateSolanaTransaction(
      transaction(),
      async () => assert.fail('RPC called'),
      controller.signal,
    ),
    error => error === reason,
  );

  const active = new AbortController();
  const pending = simulateSolanaTransaction(
    transaction(),
    async (method, params, signal) => {
      assert.equal(signal, active.signal);
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    },
    active.signal,
  );
  active.abort(reason);
  await assert.rejects(pending, error => error === reason);
});

test('late RPC responses after abort do not produce a completed simulation', async () => {
  const controller = new AbortController();
  const reason = new Error('stale request');
  const pending = simulateSolanaTransaction(
    transaction(),
    async method => {
      controller.abort(reason);
      return method === 'simulateTransaction' ? simulation() : fee();
    },
    controller.signal,
  );
  await assert.rejects(pending, error => error === reason);
});
