import assert from 'node:assert/strict';
import {test} from 'node:test';

import {reaction} from 'mobx';

// eslint-disable-next-line @mufan/scoped-modules, @mufan/import -- Exercise the service without initializing platform services.
import {EvmCallHistoryService} from '../.bld/app/@services/evm-call-history-service.js';

const ADDRESS = '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC';
const OTHER_ADDRESS = '0x0000000000000000000000000000000000000001';
const SIGNATURE = 'transfer(address,uint256)';
const CALL = {contractAddress: ADDRESS, signature: SIGNATURE};

function createStorage(context, initial) {
  let saved = initial;

  return {
    get: context.mock.fn(async key => {
      assert.equal(key, 'signedEvmCalls');
      return saved;
    }),
    set: context.mock.fn(async (key, value) => {
      assert.equal(key, 'signedEvmCalls');
      saved = structuredClone(value);
    }),
  };
}

test('missing history and empty calls do not write storage', async context => {
  for (const empty of [undefined, null]) {
    const storage = createStorage(context, empty);
    const service = await EvmCallHistoryService.create(storage);

    assert.equal(service.hasSigned('eip155:1', ADDRESS, SIGNATURE), false);
    await service.rememberSigned('eip155:1', []);
    assert.equal(storage.set.mock.callCount(), 0);
  }
});

test('history separates chains, implementations and canonical signatures while normalizing address casing across reloads', async context => {
  const storage = createStorage(context);
  const service = await EvmCallHistoryService.create(storage);
  await service.rememberSigned('eip155:1', [
    CALL,
    {...CALL, contractAddress: ADDRESS.toLowerCase()},
  ]);

  const reloaded = await EvmCallHistoryService.create(storage);
  assert.equal(reloaded.hasSigned('eip155:1', ADDRESS, SIGNATURE), true);
  assert.equal(
    reloaded.hasSigned('eip155:1', ADDRESS.toLowerCase(), SIGNATURE),
    true,
  );
  assert.equal(reloaded.hasSigned('eip155:137', ADDRESS, SIGNATURE), false);
  assert.equal(reloaded.hasSigned('eip155:1', OTHER_ADDRESS, SIGNATURE), false);
  assert.equal(
    reloaded.hasSigned('eip155:1', ADDRESS, 'transfer(address,uint256,bytes)'),
    false,
  );
  assert.equal(
    reloaded.hasSigned('eip155:1', ADDRESS, 'Transfer(address,uint256)'),
    false,
  );
  assert.deepEqual(storage.set.mock.calls[0].arguments, [
    'signedEvmCalls',
    [`eip155:1:${ADDRESS.toLowerCase()}:${SIGNATURE}`],
  ]);

  await reloaded.rememberSigned('eip155:137', [CALL]);
  assert.equal(reloaded.hasSigned('eip155:137', ADDRESS, SIGNATURE), true);
  assert.equal(reloaded.hasSigned('eip155:1', ADDRESS, SIGNATURE), true);
});

test('signed membership is observable and repeated signing is idempotent', async context => {
  const service = await EvmCallHistoryService.create(createStorage(context));
  const changes = [];
  const dispose = reaction(
    () => service.hasSigned('eip155:1', ADDRESS, SIGNATURE),
    signed => changes.push(signed),
  );
  context.after(dispose);

  await service.rememberSigned('eip155:137', [CALL]);
  await service.rememberSigned('eip155:1', [CALL]);
  await service.rememberSigned('eip155:1', [
    {...CALL, contractAddress: ADDRESS.toLowerCase()},
  ]);

  assert.deepEqual(changes, [true]);
});

test('concurrent writes are serialized and preserve every signed call', async context => {
  const storage = createStorage(context);
  const initialWrite = Promise.withResolvers();
  let saved;
  storage.set.mock.mockImplementationOnce(async (_key, value) => {
    await initialWrite.promise;
    saved = value;
  });
  storage.set.mock.mockImplementation(async (_key, value) => {
    saved = value;
  });
  const service = await EvmCallHistoryService.create(storage);
  const first = service.rememberSigned('eip155:1', [CALL]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(storage.set.mock.callCount(), 1);

  const second = service.rememberSigned('eip155:137', [CALL]);
  const third = service.rememberSigned('eip155:1', [
    {...CALL, contractAddress: OTHER_ADDRESS},
  ]);
  assert.equal(storage.set.mock.callCount(), 1);
  initialWrite.resolve();
  await Promise.all([first, second, third]);

  assert.deepEqual(saved, [
    `eip155:1:${ADDRESS.toLowerCase()}:${SIGNATURE}`,
    `eip155:137:${ADDRESS.toLowerCase()}:${SIGNATURE}`,
    `eip155:1:${OTHER_ADDRESS}:${SIGNATURE}`,
  ]);
});

test('failed writes preserve observed signing and the same call retries the complete history', async context => {
  const storage = createStorage(context);
  const failure = new Error('Storage unavailable');
  storage.set.mock.mockImplementationOnce(async () => {
    throw failure;
  });
  const service = await EvmCallHistoryService.create(storage);

  await assert.rejects(service.rememberSigned('eip155:1', [CALL]), failure);
  assert.equal(service.hasSigned('eip155:1', ADDRESS, SIGNATURE), true);
  await service.rememberSigned('eip155:1', [CALL]);
  await service.rememberSigned('eip155:137', [CALL]);

  const reloaded = await EvmCallHistoryService.create(storage);
  assert.equal(reloaded.hasSigned('eip155:1', ADDRESS, SIGNATURE), true);
  assert.equal(reloaded.hasSigned('eip155:137', ADDRESS, SIGNATURE), true);
});

test('storage read errors do not erase signed history', async context => {
  const storage = createStorage(context);
  const failure = new Error('Storage unavailable');
  storage.get.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(EvmCallHistoryService.create(storage), failure);
  assert.equal(storage.set.mock.callCount(), 0);
});
