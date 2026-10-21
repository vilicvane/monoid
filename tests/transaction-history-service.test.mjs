import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Interface, Transaction, Wallet} from 'ethers';
import {reaction} from 'mobx';

import {TransactionHistoryService} from '../.bld/app/@services/transaction-history-service.js';

// Public fixture keys only; these accounts must never hold funds.
const wallet = new Wallet(`0x${'1'.padStart(64, '0')}`);
const otherWallet = new Wallet(`0x${'2'.padStart(64, '0')}`);
const recipient = '0x3535353535353535353535353535353535353535';
const events = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

function createStorage(context, initial) {
  let saved = initial;

  return {
    get: context.mock.fn(async key => {
      assert.equal(key, 'submittedTransactions');
      return saved === undefined ? undefined : JSON.parse(saved);
    }),
    set: context.mock.fn(async (key, value) => {
      assert.equal(key, 'submittedTransactions');
      saved = JSON.stringify(value);
    }),
  };
}

async function sign({signer = wallet, chainId = 1n, nonce = 0} = {}) {
  const raw = await signer.signTransaction({
    chainId,
    type: 2,
    nonce,
    to: recipient,
    value: 5n,
    gasLimit: 21000n,
    maxFeePerGas: 3000000000n,
    maxPriorityFeePerGas: 1000000000n,
  });
  return {raw, hash: Transaction.from(raw).hash};
}

function receipt(hash, status = 1) {
  return {
    hash,
    status,
    blockNumber: 24000000,
    fee: 42000000000000n,
    logs: status
      ? [
          {
            address: recipient,
            index: 2,
            ...events.encodeEventLog(events.getEvent('Transfer'), [
              wallet.address,
              otherWallet.address,
              250000000n,
            ]),
          },
        ]
      : [],
  };
}

test('empty local history initializes without writing or inventing transactions', async context => {
  for (const initial of [undefined, 'null']) {
    const storage = createStorage(context, initial);
    const service = await TransactionHistoryService.create(storage);
    assert.deepEqual(service.addresses, []);
    assert.deepEqual(service.list(wallet.address), []);
    assert.equal(service.get(wallet.address, 'eip155:1', '0x00'), undefined);
    assert.equal(storage.set.mock.callCount(), 0);
  }
});

test('submitted transactions reload with sender filtering, chain scoping and newest-first ordering', async context => {
  const storage = createStorage(context);
  const service = await TransactionHistoryService.create(storage);
  let now = 100;
  context.mock.method(Date, 'now', () => now);
  const first = await sign();
  const second = await sign({chainId: 8453n});
  const other = await sign({signer: otherWallet});

  await service.rememberSubmitted(first.raw);
  now = 200;
  await service.rememberSubmitted(second.raw);
  now = 300;
  await service.rememberSubmitted(other.raw);

  const reloaded = await TransactionHistoryService.create(storage);
  assert.deepEqual(reloaded.addresses, [wallet.address, otherWallet.address]);
  assert.deepEqual(
    reloaded
      .list(wallet.address.toLowerCase())
      .map(item => [item.hash, item.timestamp]),
    [
      [second.hash, 200],
      [first.hash, 100],
    ],
  );
  assert.deepEqual(
    reloaded.list(otherWallet.address).map(item => item.hash),
    [other.hash],
  );
  assert.deepEqual(reloaded.list(recipient), []);

  const detail = reloaded.get(
    wallet.address.toLowerCase(),
    'eip155:1',
    first.hash.toUpperCase(),
  );
  assert.deepEqual(detail, {
    signedTransaction: first.raw,
    transaction: {
      chainId: 1n,
      hash: first.hash,
      from: wallet.address,
      to: recipient,
      value: 5n,
      timestamp: 100,
      status: 'pending',
    },
    receipt: undefined,
    submission: undefined,
  });
  assert.equal(
    reloaded.get(otherWallet.address, 'eip155:1', first.hash),
    undefined,
  );
  assert.equal(
    reloaded.get(wallet.address, 'eip155:8453', first.hash),
    undefined,
  );
});

test('repeated submissions preserve the first timestamp and cached confirmed receipt', async context => {
  const storage = createStorage(context);
  const service = await TransactionHistoryService.create(storage);
  let now = 100;
  context.mock.method(Date, 'now', () => now);
  const transaction = await sign();
  const confirmed = receipt(transaction.hash);

  await service.rememberSubmitted(transaction.raw);
  await service.rememberReceipt(1n, transaction.hash, confirmed);
  now = 500;
  await service.rememberSubmitted(transaction.raw);
  const reloaded = await TransactionHistoryService.create(storage);
  await reloaded.rememberSubmitted(transaction.raw);

  assert.equal(reloaded.list(wallet.address).length, 1);
  assert.equal(reloaded.list(wallet.address)[0].timestamp, 100);
  assert.equal(reloaded.list(wallet.address)[0].status, 'confirmed');
  assert.deepEqual(
    reloaded.get(wallet.address, 'eip155:1', transaction.hash).receipt,
    confirmed,
  );
});

test('confirmed and failed receipts normalize getters and logs into JSON-safe durable records', async context => {
  const storage = createStorage(context);
  const service = await TransactionHistoryService.create(storage);
  const confirmed = await sign();
  const failed = await sign({nonce: 1});
  await service.rememberSubmitted(confirmed.raw);
  await service.rememberSubmitted(failed.raw);

  const normalized = receipt(confirmed.hash);
  const {fee, ...fields} = normalized;
  const providerReceipt = Object.assign(
    Object.create({
      get fee() {
        return fee;
      },
    }),
    {
      ...fields,
      provider: {unexpectedBigInt: 1n},
    },
  );
  await service.rememberReceipt(1n, confirmed.hash, providerReceipt);
  await service.rememberReceipt(1n, failed.hash, receipt(failed.hash, 0));

  const reloaded = await TransactionHistoryService.create(storage);
  assert.equal(
    reloaded.get(wallet.address, 'eip155:1', confirmed.hash).transaction.status,
    'confirmed',
  );
  assert.equal(
    reloaded.get(wallet.address, 'eip155:1', failed.hash).transaction.status,
    'failed',
  );
  assert.deepEqual(
    reloaded.get(wallet.address, 'eip155:1', confirmed.hash).receipt,
    normalized,
  );
  assert.deepEqual(
    reloaded.get(wallet.address, 'eip155:1', failed.hash).receipt,
    receipt(failed.hash, 0),
  );

  const before = storage.set.mock.callCount();
  await reloaded.rememberReceipt(8453n, confirmed.hash, normalized);
  await reloaded.rememberReceipt(1n, `0x${'0'.repeat(64)}`, normalized);
  assert.equal(storage.set.mock.callCount(), before);
  assert.equal(reloaded.list(wallet.address).length, 2);
});

test('history and status are reactive without replacing data on duplicate submissions', async context => {
  const service = await TransactionHistoryService.create(
    createStorage(context),
  );
  const transaction = await sign();
  const states = [];
  const addresses = [];
  context.after(
    reaction(
      () =>
        service
          .list(wallet.address)
          .map(item => item.status)
          .join(','),
      value => states.push(value),
    ),
  );
  context.after(
    reaction(
      () => service.addresses.join(','),
      value => addresses.push(value),
    ),
  );

  await service.rememberSubmitted(transaction.raw);
  await service.rememberSubmitted(transaction.raw);
  await service.rememberReceipt(
    1n,
    transaction.hash,
    receipt(transaction.hash),
  );
  assert.deepEqual(states, ['pending', 'confirmed']);
  assert.deepEqual(addresses, [wallet.address]);
});

test('failed writes retain the original submission and receipt and retry the complete history', async context => {
  const storage = createStorage(context);
  const service = await TransactionHistoryService.create(storage);
  const failure = new Error('Storage unavailable');
  const first = await sign();
  const second = await sign({nonce: 1});
  let now = 100;
  context.mock.method(Date, 'now', () => now);
  storage.set.mock.mockImplementationOnce(async () => {
    throw failure;
  });

  await assert.rejects(service.rememberSubmitted(first.raw), failure);
  assert.equal(service.list(wallet.address)[0].timestamp, 100);
  now = 500;
  await service.rememberSubmitted(first.raw);
  await service.rememberSubmitted(second.raw);
  storage.set.mock.mockImplementationOnce(async () => {
    throw failure;
  });
  await assert.rejects(
    service.rememberReceipt(1n, first.hash, receipt(first.hash)),
    failure,
  );
  await service.rememberReceipt(1n, first.hash, receipt(first.hash));

  const reloaded = await TransactionHistoryService.create(storage);
  assert.equal(reloaded.list(wallet.address).length, 2);
  const detail = reloaded.get(wallet.address, 'eip155:1', first.hash);
  assert.equal(detail.transaction.timestamp, 100);
  assert.equal(detail.transaction.status, 'confirmed');
  assert.deepEqual(detail.receipt, receipt(first.hash));
});

test('concurrent writes are serialized and retain submissions made while an earlier save is pending', async context => {
  const storage = createStorage(context);
  const gate = Promise.withResolvers();
  const firstWrite = Promise.withResolvers();
  storage.set.mock.mockImplementationOnce(async () => {
    firstWrite.resolve();
    await gate.promise;
  });
  const service = await TransactionHistoryService.create(storage);
  const first = await sign();
  const second = await sign({nonce: 1});
  const savingFirst = service.rememberSubmitted(first.raw);
  await firstWrite.promise;
  const savingSecond = service.rememberSubmitted(second.raw);
  const savingReceipt = service.rememberReceipt(
    1n,
    first.hash,
    receipt(first.hash),
  );
  assert.equal(storage.set.mock.callCount(), 1);
  gate.resolve();
  await Promise.all([savingFirst, savingSecond, savingReceipt]);

  const reloaded = await TransactionHistoryService.create(storage);
  assert.equal(reloaded.list(wallet.address).length, 2);
  assert.equal(
    reloaded.get(wallet.address, 'eip155:1', first.hash).transaction.status,
    'confirmed',
  );
});

test('storage read failures surface without overwriting saved history', async context => {
  const storage = createStorage(context);
  const failure = new Error('Storage unavailable');
  storage.get.mock.mockImplementation(async () => {
    throw failure;
  });
  await assert.rejects(TransactionHistoryService.create(storage), failure);
  assert.equal(storage.set.mock.callCount(), 0);
});
