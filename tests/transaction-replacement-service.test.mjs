import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Transaction, Wallet} from 'ethers';

import {TransactionHistoryService} from '../.bld/app/@services/transaction-history-service.js';

// Public fixture keys only; these accounts must never hold funds.
const wallet = new Wallet(`0x${'1'.padStart(64, '0')}`);
const otherWallet = new Wallet(`0x${'2'.padStart(64, '0')}`);
const recipient = '0x3535353535353535353535353535353535353535';

async function setup(context) {
  let saved;
  const storage = {
    get: async () => saved && JSON.parse(saved),
    set: context.mock.fn(async (key, value) => {
      assert.equal(key, 'submittedTransactions');
      saved = JSON.stringify(value);
    }),
  };
  const service = await TransactionHistoryService.create(storage);
  const original = Transaction.from(
    await wallet.signTransaction({
      chainId: 1,
      type: 2,
      nonce: 7,
      to: recipient,
      value: 5n,
      data: '0x',
      gasLimit: 21000n,
      maxFeePerGas: 3000000000n,
      maxPriorityFeePerGas: 1000000000n,
    }),
  );
  await service.rememberSubmitted(original.serialized);
  const candidate = replacement(original);
  const provider = {
    getNetwork: context.mock.fn(async () => ({chainId: 1n})),
    getTransaction: context.mock.fn(async () => null),
    getTransactionReceipt: context.mock.fn(async () => null),
    getTransactionCount: context.mock.fn(async () => 7),
    broadcastTransaction: context.mock.fn(async raw => ({
      hash: Transaction.from(raw).hash,
    })),
  };
  return {service, storage, original, candidate, provider};
}

function replacement(original, kind = 'speed-up', signer = wallet) {
  const transaction = Transaction.from(original.unsignedSerialized);
  transaction.maxFeePerGas *= 2n;
  transaction.maxPriorityFeePerGas *= 2n;
  if (kind === 'cancel') {
    transaction.to = original.from;
    transaction.value = 0n;
    transaction.data = '0x';
    transaction.accessList = [];
  }
  transaction.signature = signer.signingKey.sign(transaction.unsignedHash);
  return transaction;
}

function submit(service, original, candidate, provider, kind = 'speed-up') {
  return service.submitReplacement(
    'eip155:1',
    original.hash,
    kind,
    candidate.unsignedSerialized,
    candidate.signature.serialized,
    provider,
  );
}

function detail(service, transaction) {
  return service.get(wallet.address, 'eip155:1', transaction.hash);
}

function receipt(transaction, status = 1) {
  return {
    hash: transaction.hash,
    status,
    blockNumber: 24000000,
    fee: 42000000000000n,
    logs: [],
  };
}

test('accepted replacements remain competitors until one receipt wins, including after restart', async context => {
  const {service, storage, original, candidate, provider} =
    await setup(context);
  const submitted = await submit(service, original, candidate, provider);
  assert.equal(submitted.transaction.hash, candidate.hash);
  assert.equal(submitted.signedTransaction, candidate.serialized);
  assert.equal(detail(service, original).submission, undefined);
  assert.deepEqual(
    service.list(wallet.address).map(item => item.status),
    ['pending', 'pending'],
  );
  assert.deepEqual(service.getCompetingHashes('eip155:1', original.hash), [
    candidate.hash,
  ]);
  assert.deepEqual(
    service.getCompetingHashes('eip155:8453', original.hash),
    [],
  );

  const reloaded = await TransactionHistoryService.create(storage);
  await reloaded.rememberReceipt(1n, original.hash, receipt(original));
  assert.equal(detail(reloaded, original).transaction.status, 'confirmed');
  assert.equal(detail(reloaded, candidate).transaction.status, 'replaced');
  assert.equal(detail(reloaded, candidate).replacementHash, original.hash);
  assert.deepEqual(reloaded.pendingTransactions, []);

  const restored = await TransactionHistoryService.create(storage);
  assert.equal(detail(restored, candidate).replacementHash, original.hash);
  assert.equal(detail(restored, candidate).transaction.status, 'replaced');
});

test('same-nonce replacement chains resolve together even when the winning cancellation reverted', async context => {
  const {service, original, candidate, provider} = await setup(context);
  await submit(service, original, candidate, provider);
  const cancel = replacement(candidate, 'cancel');
  await submit(service, candidate, cancel, provider, 'cancel');
  const unrelated = Transaction.from(original.unsignedSerialized);
  unrelated.nonce++;
  unrelated.signature = wallet.signingKey.sign(unrelated.unsignedHash);
  await service.rememberSubmitted(unrelated.serialized);
  const otherChain = Transaction.from(original.unsignedSerialized);
  otherChain.chainId = 8453n;
  otherChain.signature = wallet.signingKey.sign(otherChain.unsignedHash);
  await service.rememberSubmitted(otherChain.serialized);
  const otherSender = Transaction.from(original.unsignedSerialized);
  otherSender.signature = otherWallet.signingKey.sign(otherSender.unsignedHash);
  await service.rememberSubmitted(otherSender.serialized);

  await service.rememberReceipt(1n, cancel.hash, receipt(cancel, 0));
  for (const transaction of [original, candidate]) {
    assert.equal(detail(service, transaction).transaction.status, 'replaced');
    assert.equal(detail(service, transaction).replacementHash, cancel.hash);
  }
  assert.equal(detail(service, cancel).transaction.status, 'failed');
  assert.equal(detail(service, unrelated).transaction.status, 'pending');
  assert.equal(
    service.get(wallet.address, 'eip155:8453', otherChain.hash).transaction
      .status,
    'pending',
  );
  assert.equal(
    service.get(otherWallet.address, 'eip155:1', otherSender.hash).transaction
      .status,
    'pending',
  );
});

test('exact signed bytes are durable before broadcast and duplicate requests coalesce', async context => {
  const {service, storage, original, candidate, provider} =
    await setup(context);
  const gate = Promise.withResolvers();
  provider.broadcastTransaction.mock.mockImplementation(async raw => {
    const reloaded = await TransactionHistoryService.create(storage);
    assert.deepEqual(detail(reloaded, original).submission, {
      kind: 'speed-up',
      signedTransaction: raw,
    });
    await gate.promise;
    return {hash: candidate.hash};
  });
  const first = submit(service, original, candidate, provider);
  const second = submit(service, original, candidate, provider);
  assert.equal(first, second);
  gate.resolve();
  await first;
  assert.equal(provider.broadcastTransaction.mock.callCount(), 1);
  assert.deepEqual(provider.broadcastTransaction.mock.calls[0].arguments, [
    candidate.serialized,
  ]);
});

test('an ambiguous broadcast survives restart and checks its accepted hash before nonce reuse', async context => {
  const {service, storage, original, candidate, provider} =
    await setup(context);
  const timeout = new Error('Connection timed out');
  provider.broadcastTransaction.mock.mockImplementation(async () => {
    throw timeout;
  });
  await assert.rejects(submit(service, original, candidate, provider), timeout);
  const restored = await TransactionHistoryService.create(storage);
  assert.equal(
    detail(restored, original).submission.signedTransaction,
    candidate.serialized,
  );
  await assert.rejects(
    submit(restored, original, replacement(candidate), provider),
    /Retry the replacement/,
  );

  provider.getTransaction.mock.mockImplementation(async hash => ({hash}));
  provider.getTransactionCount.mock.resetCalls();
  const result = await submit(restored, original, candidate, provider);
  assert.equal(result.transaction.hash, candidate.hash);
  assert.equal(provider.getTransactionCount.mock.callCount(), 0);
  assert.equal(provider.broadcastTransaction.mock.callCount(), 1);
  assert.equal(detail(restored, original).submission, undefined);
});

test('a dropped broadcast response is recovered by the exact hash lookup', async context => {
  const {service, original, candidate, provider} = await setup(context);
  provider.broadcastTransaction.mock.mockImplementation(async () => {
    provider.getTransaction.mock.mockImplementation(async hash => ({hash}));
    throw new Error('Response lost');
  });
  const result = await submit(service, original, candidate, provider);
  assert.equal(result.transaction.hash, candidate.hash);
  assert.equal(detail(service, original).submission, undefined);
});

test('new replacements must also beat known same-nonce competitors without blocking exact saved retries', async context => {
  const {service, original, candidate, provider} = await setup(context);
  const timeout = new Error('Response lost');
  provider.broadcastTransaction.mock.mockImplementation(async () => {
    throw timeout;
  });
  await assert.rejects(submit(service, original, candidate, provider), timeout);
  const higher = replacement(candidate);
  await service.rememberSubmitted(higher.serialized);
  assert.deepEqual(
    service.getCompetingTransactions('eip155:1', original.hash),
    [candidate.serialized, higher.serialized],
  );

  provider.getTransaction.mock.mockImplementation(async hash => ({hash}));
  await submit(service, original, candidate, provider);
  const insufficient = replacement(original, 'cancel');
  assert.throws(
    () => submit(service, original, insufficient, provider, 'cancel'),
    /Increase both/,
  );
  const enough = replacement(higher, 'cancel');
  const result = await submit(service, original, enough, provider, 'cancel');
  assert.equal(result.transaction.hash, enough.hash);
  assert.equal(provider.broadcastTransaction.mock.callCount(), 1);
});

test('a timed-out submission discovered mined after restart resolves without another send', async context => {
  const {service, storage, original, candidate, provider} =
    await setup(context);
  provider.broadcastTransaction.mock.mockImplementation(async () => {
    throw new Error('Response lost');
  });
  await assert.rejects(
    submit(service, original, candidate, provider),
    /Response lost/,
  );

  const restored = await TransactionHistoryService.create(storage);
  assert.deepEqual(restored.getCompetingHashes('eip155:1', original.hash), [
    candidate.hash,
  ]);
  assert.equal(detail(restored, candidate), undefined);
  await restored.rememberReceipt(8453n, candidate.hash, receipt(candidate));
  assert.equal(detail(restored, candidate), undefined);
  assert.throws(
    () => restored.rememberReceipt(1n, candidate.hash, receipt(original)),
    /different transaction hash/,
  );
  assert.equal(detail(restored, candidate), undefined);

  await restored.rememberReceipt(1n, candidate.hash, receipt(candidate));
  assert.equal(
    detail(restored, candidate).signedTransaction,
    candidate.serialized,
  );
  assert.equal(detail(restored, candidate).transaction.status, 'confirmed');
  assert.equal(detail(restored, original).transaction.status, 'replaced');
  assert.equal(detail(restored, original).replacementHash, candidate.hash);
  assert.equal(detail(restored, original).submission, undefined);
  assert.deepEqual(restored.getCompetingHashes('eip155:1', original.hash), [
    candidate.hash,
  ]);
  assert.equal(provider.broadcastTransaction.mock.callCount(), 1);

  const reloaded = await TransactionHistoryService.create(storage);
  assert.equal(detail(reloaded, candidate).transaction.status, 'confirmed');
  assert.equal(detail(reloaded, original).replacementHash, candidate.hash);
  assert.equal(detail(reloaded, original).submission, undefined);
});

test('definitive fee and balance rejections release the saved submission for revision', async context => {
  for (const code of ['REPLACEMENT_UNDERPRICED', 'INSUFFICIENT_FUNDS']) {
    await context.test(code, async context => {
      const {service, storage, original, candidate, provider} =
        await setup(context);
      const error = Object.assign(new Error(code), {code});
      provider.broadcastTransaction.mock.mockImplementation(async () => {
        throw error;
      });
      await assert.rejects(
        submit(service, original, candidate, provider),
        error,
      );
      assert.equal(detail(service, original).submission, undefined);
      const restored = await TransactionHistoryService.create(storage);
      assert.equal(detail(restored, original).submission, undefined);
      assert.equal(restored.list(wallet.address).length, 1);
    });
  }
});

test('a mined original prevents broadcast and saves the receipt', async context => {
  const {service, original, candidate, provider} = await setup(context);
  provider.getTransactionReceipt.mock.mockImplementation(async () =>
    receipt(original),
  );
  await assert.rejects(
    submit(service, original, candidate, provider),
    /no longer pending/,
  );
  assert.equal(detail(service, original).transaction.status, 'confirmed');
  assert.equal(detail(service, original).submission, undefined);
  assert.equal(provider.broadcastTransaction.mock.callCount(), 0);
});

test('a used nonce prevents broadcast without inventing a replacement or dropping recovery bytes', async context => {
  const {service, original, candidate, provider} = await setup(context);
  provider.getTransactionCount.mock.mockImplementation(async () => 8);
  await assert.rejects(
    submit(service, original, candidate, provider),
    /nonce has already been used/,
  );
  assert.equal(detail(service, original).transaction.status, 'pending');
  assert.equal(
    detail(service, original).submission.signedTransaction,
    candidate.serialized,
  );
  assert.equal(provider.broadcastTransaction.mock.callCount(), 0);
  assert.deepEqual(provider.getTransactionCount.mock.calls[0].arguments, [
    wallet.address,
    'latest',
  ]);
});

test('a failed pre-broadcast save never sends the replacement', async context => {
  const {service, original, candidate, provider, storage} =
    await setup(context);
  const error = new Error('Storage full');
  storage.set.mock.mockImplementationOnce(async () => {
    throw error;
  });
  await assert.rejects(submit(service, original, candidate, provider), error);
  assert.equal(provider.broadcastTransaction.mock.callCount(), 0);
  await submit(service, original, candidate, provider);
  assert.equal(provider.broadcastTransaction.mock.callCount(), 1);
});

test('replacement validation rejects changed actions, wrong signers and wrong RPC networks', async context => {
  const {service, original, candidate, provider} = await setup(context);
  const changed = replacement(original);
  changed.value++;
  changed.signature = wallet.signingKey.sign(changed.unsignedHash);
  assert.throws(
    () => submit(service, original, changed, provider),
    /preserve the original/,
  );
  const wrongSigner = replacement(original, 'speed-up', otherWallet);
  assert.throws(
    () => submit(service, original, wrongSigner, provider),
    /original account/,
  );
  provider.getNetwork.mock.mockImplementation(async () => ({chainId: 8453n}));
  await assert.rejects(
    submit(service, original, candidate, provider),
    /different network/,
  );
  assert.equal(detail(service, original).submission, undefined);
  assert.equal(provider.broadcastTransaction.mock.callCount(), 0);
});
