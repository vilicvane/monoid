import assert from 'node:assert/strict';
import {test} from 'node:test';

import {reaction} from 'mobx';

import {AddressBookService} from '../.bld/app/@services/address-book-service.js';

const ADDRESS = '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC';
const OTHER_ADDRESS = '0x0000000000000000000000000000000000000001';

function createStorage(context, initial) {
  let saved = initial;

  return {
    get: context.mock.fn(async key => {
      assert.equal(key, 'addressRecords');
      return saved;
    }),
    set: context.mock.fn(async (key, value) => {
      assert.equal(key, 'addressRecords');
      saved = structuredClone(value);
    }),
  };
}

test('missing address records initialize empty without writing storage', async context => {
  for (const empty of [undefined, null]) {
    const storage = createStorage(context, empty);
    const service = await AddressBookService.create(storage);

    assert.equal(service.hasSigned('evm', ADDRESS), false);
    assert.equal(service.getMark('evm', ADDRESS), undefined);
    assert.equal(storage.set.mock.callCount(), 0);
  }
});

test('signed addresses persist across reloads with case-insensitive EVM matching and separate address chains', async context => {
  const storage = createStorage(context);
  const service = await AddressBookService.create(storage);

  assert.equal(service.hasSigned('evm', ADDRESS), false);
  await service.rememberSigned('evm', [ADDRESS, ADDRESS.toLowerCase()]);

  assert.equal(service.hasSigned('evm', ADDRESS), true);
  assert.equal(service.hasSigned('evm', ADDRESS.toLowerCase()), true);
  assert.equal(service.hasSigned('solana', ADDRESS), false);
  assert.deepEqual(storage.set.mock.calls[0].arguments, [
    'addressRecords',
    {evm: {[ADDRESS.toLowerCase()]: {signed: true}}},
  ]);

  const reloaded = await AddressBookService.create(storage);
  assert.equal(reloaded.hasSigned('evm', ADDRESS), true);
  assert.equal(reloaded.hasSigned('solana', ADDRESS), false);
  await reloaded.rememberSigned('solana', [OTHER_ADDRESS]);
  assert.equal(reloaded.hasSigned('evm', OTHER_ADDRESS), false);
  assert.equal(reloaded.hasSigned('solana', OTHER_ADDRESS), true);
});

test('Solana and Bitcoin records preserve address casing for both history and manual marks', async context => {
  const storage = createStorage(context);
  const service = await AddressBookService.create(storage);
  const examples = [
    ['solana', 'GvDMxPzRWxJC7Nc6yPnA89m21Tu5bHzBQ7Jec9XQdaKV'],
    ['bitcoin', '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'],
  ];

  for (const [chain, address] of examples) {
    await service.rememberSigned(chain, [address]);
    await service.setMark(chain, address, 'trusted');
    assert.equal(service.hasSigned(chain, address.toLowerCase()), false);
    assert.equal(service.getMark(chain, address.toLowerCase()), undefined);
  }

  const reloaded = await AddressBookService.create(storage);

  for (const [chain, address] of examples) {
    assert.equal(reloaded.hasSigned(chain, address), true);
    assert.equal(reloaded.getMark(chain, address), 'trusted');
    assert.equal(reloaded.hasSigned(chain, address.toLowerCase()), false);
    assert.equal(reloaded.getMark('evm', address), undefined);
  }
});

test('manual marks persist independently of signed history and can be changed or cleared', async context => {
  const storage = createStorage(context);
  const service = await AddressBookService.create(storage);

  await service.setMark('evm', ADDRESS, 'trusted');
  assert.equal(service.getMark('evm', ADDRESS.toLowerCase()), 'trusted');
  assert.equal(service.getMark('solana', ADDRESS), undefined);
  assert.equal(service.hasSigned('evm', ADDRESS), false);

  const reloaded = await AddressBookService.create(storage);
  assert.equal(reloaded.getMark('evm', ADDRESS), 'trusted');
  assert.equal(reloaded.hasSigned('evm', ADDRESS), false);
  await reloaded.setMark('solana', ADDRESS, 'dangerous');
  await reloaded.setMark('evm', ADDRESS, 'dangerous');
  await reloaded.rememberSigned('evm', [ADDRESS]);
  assert.equal(reloaded.getMark('evm', ADDRESS), 'dangerous');

  await reloaded.setMark('evm', ADDRESS, undefined);
  assert.equal(reloaded.hasSigned('evm', ADDRESS), true);
  assert.equal(reloaded.getMark('evm', ADDRESS), undefined);
  assert.equal(reloaded.getMark('solana', ADDRESS), 'dangerous');
  await reloaded.setMark('solana', ADDRESS, undefined);

  assert.deepEqual(storage.set.mock.calls.at(-1).arguments, [
    'addressRecords',
    {evm: {[ADDRESS.toLowerCase()]: {signed: true}}},
  ]);
  const afterClear = await AddressBookService.create(storage);
  assert.equal(afterClear.getMark('solana', ADDRESS), undefined);
  assert.equal(afterClear.hasSigned('solana', ADDRESS), false);
});

test('signed membership and manual marks are observable independently', async context => {
  const service = await AddressBookService.create(createStorage(context));
  const signed = [];
  const marks = [];
  const disposeSigned = reaction(
    () => service.hasSigned('evm', ADDRESS),
    value => signed.push(value),
  );
  const disposeMark = reaction(
    () => service.getMark('evm', ADDRESS),
    value => marks.push(value),
  );

  await service.setMark('evm', ADDRESS, 'trusted');
  await service.rememberSigned('evm', [ADDRESS]);
  await service.rememberSigned('evm', [ADDRESS.toLowerCase()]);
  await service.rememberSigned('evm', []);
  await service.setMark('evm', ADDRESS, undefined);

  assert.deepEqual(signed, [true]);
  assert.deepEqual(marks, ['trusted', undefined]);
  disposeSigned();
  disposeMark();
});

test('concurrent writes are serialized and preserve signed addresses and manual marks', async context => {
  const storage = createStorage(context);
  const initialWrite = Promise.withResolvers();
  const save = storage.set;
  let saved;

  save.mock.mockImplementationOnce(async (_key, value) => {
    await initialWrite.promise;
    saved = value;
  });
  save.mock.mockImplementation(async (_key, value) => {
    saved = value;
  });
  const service = await AddressBookService.create(storage);
  const first = service.rememberSigned('evm', [ADDRESS]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(save.mock.callCount(), 1);

  const second = service.setMark('evm', ADDRESS, 'trusted');
  const third = service.rememberSigned('evm', [OTHER_ADDRESS]);
  const fourth = service.rememberSigned('solana', [ADDRESS]);
  assert.equal(save.mock.callCount(), 1);
  initialWrite.resolve();
  await Promise.all([first, second, third, fourth]);

  assert.deepEqual(saved, {
    evm: {
      [ADDRESS.toLowerCase()]: {signed: true, mark: 'trusted'},
      [OTHER_ADDRESS]: {signed: true},
    },
    solana: {[ADDRESS]: {signed: true}},
  });
});

test('write failures propagate while preserving in-memory facts and later saves retry the full history', async context => {
  const storage = createStorage(context);
  const failure = new Error('Storage unavailable');
  storage.set.mock.mockImplementationOnce(async () => {
    throw failure;
  });
  const service = await AddressBookService.create(storage);

  await assert.rejects(service.rememberSigned('evm', [ADDRESS]), failure);
  assert.equal(service.hasSigned('evm', ADDRESS), true);
  await service.rememberSigned('evm', [ADDRESS.toLowerCase()]);

  storage.set.mock.mockImplementationOnce(async () => {
    throw failure;
  });
  await assert.rejects(service.setMark('evm', ADDRESS, 'dangerous'), failure);
  assert.equal(service.getMark('evm', ADDRESS), 'dangerous');
  await service.setMark('evm', ADDRESS, 'dangerous');

  const reloaded = await AddressBookService.create(storage);
  assert.equal(reloaded.hasSigned('evm', ADDRESS), true);
  assert.equal(reloaded.getMark('evm', ADDRESS), 'dangerous');
});

test('storage read failures are not mistaken for an empty signing history', async context => {
  const storage = createStorage(context);
  const failure = new Error('Storage unavailable');
  storage.get.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(AddressBookService.create(storage), failure);
  assert.equal(storage.set.mock.callCount(), 0);
});
