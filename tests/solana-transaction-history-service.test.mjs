import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {test} from 'node:test';

import {base58} from '@scure/base';
import {reaction} from 'mobx';

import {SolanaTransactionHistoryService} from '../.bld/app/@services/solana-transaction-history-service.js';

const CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const STORAGE = 'submittedSolanaTransactions';

function signingKey() {
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  const bytes = publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
  return {privateKey, bytes, address: base58.encode(bytes)};
}

const payer = signingKey();
const signer = signingKey();

function transaction(
  blockhash = 4,
  missingSignature = false,
  missingPayer = false,
) {
  const message = Uint8Array.from([
    0x80,
    2,
    0,
    1,
    3,
    ...payer.bytes,
    ...signer.bytes,
    ...new Uint8Array(32),
    ...new Uint8Array(32).fill(blockhash),
    1,
    2,
    2,
    0,
    1,
    12,
    2,
    0,
    0,
    0,
    1,
    ...new Uint8Array(7),
    0,
  ]);
  const signature = sign(null, message, payer.privateKey);
  return {
    id: base58.encode(createHash('sha256').update(message).digest()),
    signature: base58.encode(signature),
    signedTransaction: Buffer.from([
      2,
      ...(missingPayer ? new Uint8Array(64) : signature),
      ...(missingSignature
        ? new Uint8Array(64)
        : sign(null, message, signer.privateKey)),
      ...message,
    ]).toString('base64'),
  };
}

function storageFixture(context, initial) {
  let saved = initial;
  return {
    get: context.mock.fn(async key => {
      assert.equal(key, STORAGE);
      return saved === undefined ? undefined : JSON.parse(saved);
    }),
    set: context.mock.fn(async (key, value) => {
      assert.equal(key, STORAGE);
      saved = JSON.stringify(value);
    }),
  };
}

test('empty history does not invent or write transactions', async context => {
  const storage = storageFixture(context);
  const service = await SolanaTransactionHistoryService.create(storage);
  assert.deepEqual(service.list(signer.address), []);
  assert.deepEqual(service.pendingTransactions, []);
  assert.equal(service.getConfirmation(CHAIN, 'missing'), undefined);
  assert.equal(storage.set.mock.callCount(), 0);
});

test('balance snapshots retain exact token amounts, ownership changes and unavailable categories after restart', async context => {
  const storage = storageFixture(context);
  const service = await SolanaTransactionHistoryService.create(storage);
  const fixture = transaction();
  await service.rememberSubmitted(
    CHAIN,
    signer.address,
    fixture.signedTransaction,
    100,
  );
  await service.rememberSubmitted(
    CHAIN,
    payer.address,
    fixture.signedTransaction,
    200,
  );
  const balances = {
    native: [{address: payer.address, before: 1000000000n, after: 999995000n}],
    tokens: [
      {
        address: signingKey().address,
        mint: signingKey().address,
        decimals: 9,
        programId: signingKey().address,
        before: {amount: 9007199254740993n, owner: signer.address},
        after: {amount: 9007199254740992n, owner: payer.address},
      },
      {
        address: signingKey().address,
        mint: signingKey().address,
        decimals: 6,
        before: {amount: 1234567n},
        after: undefined,
      },
    ],
  };
  await service.rememberConfirmation(CHAIN, fixture.signature, {
    status: 'confirmed',
    slot: 123,
    fee: 5000n,
    balances,
  });
  const restored = await SolanaTransactionHistoryService.create(storage);
  for (const address of [signer.address, payer.address]) {
    assert.deepEqual(
      restored.get(address, CHAIN, fixture.id).confirmation.balances,
      balances,
    );
  }
  const writes = storage.set.mock.callCount();
  await service.rememberConfirmation(CHAIN, fixture.signature, {
    status: 'confirmed',
    slot: 123,
    balances: structuredClone(balances),
  });
  await service.rememberConfirmation(CHAIN, fixture.signature, {
    status: 'confirmed',
    slot: 123,
    balances: {},
    error: Error('RPC incomplete'),
  });
  assert.equal(storage.set.mock.callCount(), writes);
  assert.deepEqual(
    service.getConfirmation(CHAIN, fixture.signature).balances,
    balances,
  );
});

test('missing balances differ from fetched unavailable balances and later categories fill the cache', async context => {
  const storage = storageFixture(context);
  let service = await SolanaTransactionHistoryService.create(storage);
  const fixture = transaction();
  await service.rememberSubmitted(
    CHAIN,
    signer.address,
    fixture.signedTransaction,
    100,
  );
  const initial = {status: 'confirmed', slot: 123, fee: 5000n};
  await service.rememberConfirmation(CHAIN, fixture.signature, initial);
  service = await SolanaTransactionHistoryService.create(storage);
  assert.equal(
    service.getConfirmation(CHAIN, fixture.signature).balances,
    undefined,
  );

  await service.rememberConfirmation(CHAIN, fixture.signature, {
    ...initial,
    balances: {},
  });
  service = await SolanaTransactionHistoryService.create(storage);
  assert.ok(service.getConfirmation(CHAIN, fixture.signature).balances);
  assert.equal(
    service.getConfirmation(CHAIN, fixture.signature).balances.native,
    undefined,
  );
  assert.equal(
    service.getConfirmation(CHAIN, fixture.signature).balances.tokens,
    undefined,
  );

  await service.rememberConfirmation(CHAIN, fixture.signature, {
    ...initial,
    balances: {tokens: []},
  });
  const native = [{address: signer.address, before: 100000n, after: 95000n}];
  await service.rememberConfirmation(CHAIN, fixture.signature, {
    ...initial,
    balances: {native},
  });
  service = await SolanaTransactionHistoryService.create(storage);
  assert.deepEqual(service.getConfirmation(CHAIN, fixture.signature).balances, {
    native,
    tokens: [],
  });
});

test('a partial signature has a stable local ID without inventing the missing fee-payer signature', async context => {
  const storage = storageFixture(context);
  const service = await SolanaTransactionHistoryService.create(storage);
  const partial = transaction(4, false, true);
  await service.rememberSigned(
    CHAIN,
    signer.address,
    partial.signedTransaction,
    100,
  );
  const detail = service.get(signer.address, CHAIN, partial.id);
  assert.equal(detail.transaction.id, partial.id);
  assert.equal(detail.transaction.signature, undefined);
  assert.equal(detail.transaction.status, 'signed');
  assert.equal(detail.signedTransaction, partial.signedTransaction);
  assert.equal(service.getBySignature(CHAIN, partial.id), undefined);
  assert.equal(service.getBySignature(CHAIN, partial.signature), undefined);
  assert.deepEqual(service.pendingTransactions, []);
  assert.throws(
    () =>
      service.rememberSigned(CHAIN, payer.address, partial.signedTransaction),
    /did not sign/,
  );
  const restored = await SolanaTransactionHistoryService.create(storage);
  assert.equal(
    restored.get(signer.address, CHAIN, partial.id).transaction.status,
    'signed',
  );
  assert.equal(
    restored.get(signer.address, CHAIN, partial.id).transaction.signature,
    undefined,
  );
});

test('additional signatures fill the same message record across signers and do not imply broadcast', async context => {
  const storage = storageFixture(context);
  const service = await SolanaTransactionHistoryService.create(storage);
  const payerOnly = transaction(4, true);
  const signerOnly = transaction(4, false, true);
  const complete = transaction();
  await service.rememberSigned(
    CHAIN,
    payer.address,
    payerOnly.signedTransaction,
    100,
  );
  assert.deepEqual(service.getConfirmation(CHAIN, complete.signature), {
    status: 'signed',
  });
  assert.equal(service.pendingTransactions[0].signature, complete.signature);
  await service.rememberSigned(
    CHAIN,
    signer.address,
    signerOnly.signedTransaction,
    200,
  );
  for (const address of [payer.address, signer.address]) {
    const detail = service.get(address, CHAIN, complete.id);
    assert.equal(detail.transaction.id, complete.id);
    assert.equal(detail.transaction.signature, complete.signature);
    assert.equal(detail.transaction.status, 'signed');
    assert.equal(detail.signedTransaction, complete.signedTransaction);
  }
  await service.rememberSigned(
    CHAIN,
    payer.address,
    payerOnly.signedTransaction,
    300,
  );
  await service.rememberSubmitted(
    CHAIN,
    signer.address,
    complete.signedTransaction,
    400,
  );
  assert.equal(service.list(payer.address)[0].timestamp, 100);
  assert.equal(service.list(signer.address)[0].timestamp, 200);
  assert.equal(service.list(payer.address)[0].status, 'pending');
  const confirmation = {status: 'confirmed', slot: 123, fee: 5000n};
  await service.rememberConfirmation(CHAIN, complete.signature, confirmation);
  await service.rememberSigned(
    CHAIN,
    signer.address,
    signerOnly.signedTransaction,
    500,
  );
  await service.rememberSubmitted(
    CHAIN,
    payer.address,
    complete.signedTransaction,
    600,
  );
  const restored = await SolanaTransactionHistoryService.create(storage);
  assert.equal(
    restored.getBySignature(CHAIN, complete.signature).transaction.status,
    'confirmed',
  );
  assert.equal(restored.getConfirmation(CHAIN, complete.signature).fee, 5000n);
  assert.equal(restored.list(payer.address)[0].timestamp, 100);
  assert.equal(restored.list(signer.address)[0].timestamp, 200);
  assert.equal(
    restored.get(signer.address, CHAIN, complete.id).signedTransaction,
    complete.signedTransaction,
  );
});

test('successful lookup transitions persist while RPC failures do not expire or regress history', async context => {
  const storage = storageFixture(context);
  const service = await SolanaTransactionHistoryService.create(storage);
  const fixture = transaction(4, true);
  await service.rememberSigned(
    CHAIN,
    payer.address,
    fixture.signedTransaction,
    100,
  );
  for (const status of ['signed', 'not-found', 'pending']) {
    await service.rememberConfirmation(CHAIN, fixture.signature, {
      status,
      error: new Error('Offline'),
    });
    assert.equal(
      service.getBySignature(CHAIN, fixture.signature).transaction.status,
      'signed',
    );
  }
  await service.rememberConfirmation(CHAIN, fixture.signature, {
    status: 'not-found',
  });
  let restored = await SolanaTransactionHistoryService.create(storage);
  assert.deepEqual(restored.getConfirmation(CHAIN, fixture.signature), {
    status: 'not-found',
  });
  assert.deepEqual(restored.pendingTransactions, []);
  await service.rememberConfirmation(CHAIN, fixture.signature, {
    status: 'signed',
  });
  assert.equal(
    service.getBySignature(CHAIN, fixture.signature).transaction.status,
    'not-found',
  );
  await service.rememberConfirmation(CHAIN, fixture.signature, {
    status: 'pending',
  });
  await service.rememberConfirmation(CHAIN, fixture.signature, {
    status: 'not-found',
  });
  restored = await SolanaTransactionHistoryService.create(storage);
  assert.deepEqual(restored.getConfirmation(CHAIN, fixture.signature), {
    status: 'pending',
  });
  assert.equal(restored.pendingTransactions.length, 1);
  await service.rememberConfirmation(CHAIN, fixture.signature, {
    status: 'failed',
    slot: 123,
  });
  await service.rememberConfirmation(CHAIN, fixture.signature, {
    status: 'confirmed',
    slot: 124,
  });
  await service.rememberConfirmation(CHAIN, fixture.signature, {
    status: 'pending',
  });
  assert.equal(
    service.getConfirmation(CHAIN, fixture.signature).status,
    'failed',
  );
});

test('signed history retries persistence without resetting the first signing timestamp', async context => {
  const storage = storageFixture(context);
  const service = await SolanaTransactionHistoryService.create(storage);
  const fixture = transaction(4, false, true);
  storage.set.mock.mockImplementationOnce(async () => {
    throw new Error('Disk full');
  });
  await assert.rejects(
    service.rememberSigned(
      CHAIN,
      signer.address,
      fixture.signedTransaction,
      100,
    ),
    /Disk full/,
  );
  await service.rememberSigned(
    CHAIN,
    signer.address,
    fixture.signedTransaction,
    200,
  );
  const restored = await SolanaTransactionHistoryService.create(storage);
  assert.equal(restored.list(signer.address)[0].timestamp, 100);
  assert.equal(restored.list(signer.address)[0].status, 'signed');
});

test('history preserves exact signer, network, signature, bytes and ordering after restart', async context => {
  const storage = storageFixture(context);
  const service = await SolanaTransactionHistoryService.create(storage);
  const first = transaction();
  const second = transaction(5);
  await service.rememberSubmitted(
    CHAIN,
    signer.address,
    first.signedTransaction,
    100,
  );
  await service.rememberSubmitted(
    DEVNET,
    signer.address,
    first.signedTransaction,
    200,
  );
  await service.rememberSubmitted(
    CHAIN,
    signer.address,
    second.signedTransaction,
    300,
  );
  const writes = storage.set.mock.callCount();
  await service.rememberSubmitted(
    CHAIN,
    signer.address,
    first.signedTransaction,
    400,
  );
  assert.equal(storage.set.mock.callCount(), writes);

  const restored = await SolanaTransactionHistoryService.create(storage);
  assert.deepEqual(
    restored.list(signer.address).map(item => [item.chainId, item.timestamp]),
    [
      [CHAIN, 300],
      [DEVNET, 200],
      [CHAIN, 100],
    ],
  );
  assert.deepEqual(restored.list(signer.address.toLowerCase()), []);
  assert.deepEqual(restored.list(payer.address), []);
  assert.equal(
    restored.get(signer.address, CHAIN, first.id.toLowerCase()),
    undefined,
  );
  assert.equal(
    restored.get(signer.address, CHAIN, first.id).signedTransaction,
    first.signedTransaction,
  );
  assert.equal(
    restored.get(signer.address, DEVNET, first.id).transaction.timestamp,
    200,
  );
  assert.equal(restored.pendingTransactions.length, 3);
});

test('confirmation and late fee update all recorded signers, without transient errors or status regression', async context => {
  const storage = storageFixture(context);
  const service = await SolanaTransactionHistoryService.create(storage);
  const fixture = transaction();
  const remember = (address, chain = CHAIN) =>
    service.rememberSubmitted(chain, address, fixture.signedTransaction, 100);
  await remember(signer.address);
  await remember(signer.address, DEVNET);
  await service.rememberConfirmation(CHAIN, fixture.signature, {
    status: 'confirmed',
    slot: 22,
  });
  await remember(payer.address);
  assert.equal(
    service.get(payer.address, CHAIN, fixture.id).transaction.status,
    'confirmed',
  );
  await service.rememberConfirmation(CHAIN, fixture.signature, {
    status: 'confirmed',
    slot: 22,
    fee: 9007199254740993n,
    error: new Error('RPC offline'),
  });
  await service.rememberConfirmation(CHAIN, fixture.signature, {
    status: 'pending',
    error: new Error('RPC offline'),
  });
  const writes = storage.set.mock.callCount();
  await service.rememberConfirmation(CHAIN, fixture.signature, {
    status: 'confirmed',
    slot: 22,
    error: new Error('RPC offline'),
  });
  assert.equal(storage.set.mock.callCount(), writes);

  const restored = await SolanaTransactionHistoryService.create(storage);
  for (const address of [signer.address, payer.address]) {
    const detail = restored.get(address, CHAIN, fixture.id);
    assert.equal(detail.transaction.status, 'confirmed');
    assert.equal(detail.confirmation.fee, 9007199254740993n);
    assert.equal('error' in detail.confirmation, false);
  }
  assert.deepEqual(restored.getConfirmation(DEVNET, fixture.signature), {
    status: 'pending',
  });
  assert.deepEqual(
    restored.pendingTransactions.map(item => item.chainId),
    [DEVNET],
  );
});

test('failed execution survives restart and observable lists update on confirmation', async context => {
  const storage = storageFixture(context);
  const service = await SolanaTransactionHistoryService.create(storage);
  const fixture = transaction();
  const statuses = [];
  const dispose = reaction(
    () => service.list(signer.address).map(item => item.status),
    value => statuses.push(value),
  );
  try {
    await service.rememberSubmitted(
      CHAIN,
      signer.address,
      fixture.signedTransaction,
      100,
    );
    await service.rememberConfirmation(CHAIN, fixture.signature, {
      status: 'failed',
      slot: 23,
      fee: 5000n,
      executionError: '{"InstructionError":[0,{"Custom":1}]}',
    });
    const restored = await SolanaTransactionHistoryService.create(storage);
    assert.equal(
      restored.getConfirmation(CHAIN, fixture.signature).status,
      'failed',
    );
    assert.match(
      restored.getConfirmation(CHAIN, fixture.signature).executionError,
      /InstructionError/,
    );
    assert.deepEqual(statuses, [['pending'], ['failed']]);
    assert.deepEqual(restored.pendingTransactions, []);
  } finally {
    dispose();
  }
});

test('failed writes retry identical submissions and confirmations without changing first timestamp', async context => {
  const storage = storageFixture(context);
  const service = await SolanaTransactionHistoryService.create(storage);
  const fixture = transaction();
  const failure = new Error('Disk full');
  storage.set.mock.mockImplementationOnce(async () => {
    throw failure;
  });
  await assert.rejects(
    service.rememberSubmitted(
      CHAIN,
      signer.address,
      fixture.signedTransaction,
      100,
    ),
    failure,
  );
  await service.rememberSubmitted(
    CHAIN,
    signer.address,
    fixture.signedTransaction,
    200,
  );
  const confirmation = {status: 'confirmed', slot: 24, fee: 5000n};
  storage.set.mock.mockImplementationOnce(async () => {
    throw failure;
  });
  await assert.rejects(
    service.rememberConfirmation(CHAIN, fixture.signature, confirmation),
    failure,
  );
  await service.rememberConfirmation(CHAIN, fixture.signature, confirmation);
  const restored = await SolanaTransactionHistoryService.create(storage);
  assert.equal(
    restored.get(signer.address, CHAIN, fixture.id).transaction.timestamp,
    100,
  );
  assert.equal(restored.getConfirmation(CHAIN, fixture.signature).fee, 5000n);
});

test('an incomplete transaction or unrelated account cannot enter submitted history', async context => {
  const storage = storageFixture(context);
  const service = await SolanaTransactionHistoryService.create(storage);
  assert.throws(
    () =>
      service.rememberSubmitted(
        CHAIN,
        signer.address,
        transaction(4, true).signedTransaction,
      ),
    /missing a required signature/,
  );
  assert.throws(
    () =>
      service.rememberSubmitted(
        CHAIN,
        signingKey().address,
        transaction().signedTransaction,
      ),
    /did not sign/,
  );
  assert.deepEqual(service.pendingTransactions, []);
  assert.equal(storage.set.mock.callCount(), 0);
});

test('writes serialize snapshots while newer records arrive', async context => {
  const storage = storageFixture(context);
  const service = await SolanaTransactionHistoryService.create(storage);
  const fixture = transaction();
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  storage.set.mock.mockImplementationOnce(async () => {
    started.resolve();
    await finish.promise;
  });
  const first = service.rememberSubmitted(
    CHAIN,
    signer.address,
    fixture.signedTransaction,
    100,
  );
  await started.promise;
  const second = service.rememberSubmitted(
    DEVNET,
    signer.address,
    fixture.signedTransaction,
    200,
  );
  finish.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(
    storage.set.mock.calls.map(call => call.arguments[1].length),
    [1, 2],
  );
  assert.equal(
    (await SolanaTransactionHistoryService.create(storage)).list(signer.address)
      .length,
    2,
  );
});
