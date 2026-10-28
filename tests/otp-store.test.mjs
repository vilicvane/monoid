import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {reaction} from 'mobx';

import {OTPStore} from '../.bld/app/@services/otp-store.js';

function account(overrides = {}) {
  return {
    index: `f201${'12'.repeat(8)}`,
    label: 'Example: alice',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    ...overrides,
  };
}
function storageFixture(context, initial) {
  let saved = structuredClone(initial);
  return {
    get: context.mock.fn(async key => {
      assert.equal(key, 'otpAccounts');
      return structuredClone(saved);
    }),
    set: context.mock.fn(async (key, value) => {
      assert.equal(key, 'otpAccounts');
      saved = structuredClone(value);
    }),
  };
}

test('OTP import handoffs are one-use and never persist their URI or secret', async context => {
  const storage = storageFixture(context);
  const store = await OTPStore.create(storage);
  const uri = 'otpauth://totp/Example?secret=MY';
  const first = store.prepareImport(uri);
  assert.equal(store.takeImport('wrong-id'), undefined);
  assert.equal(store.takeImport(first), uri);
  assert.equal(store.takeImport(first), undefined);
  const cancelled = store.prepareImport(uri);
  store.discardImport(cancelled);
  assert.equal(store.takeImport(cancelled), undefined);
  const older = store.prepareImport(uri);
  const latest = store.prepareImport(uri);
  store.discardImport(older);
  assert.equal(store.takeImport(latest), uri);
  assert.equal(storage.set.mock.callCount(), 0);
});

test('scans merge across cards and duplicate backup accounts update in place', async context => {
  const storage = storageFixture(context);
  const store = await OTPStore.create(storage);
  const other = account({index: `f201${'56'.repeat(8)}`});
  await store.save([account()]);
  await store.save([other]);
  await store.save([account({label: 'Updated label'})]);
  await store.save([]);
  assert.deepEqual(store.accounts, [account({label: 'Updated label'}), other]);
  assert.deepEqual((await OTPStore.create(storage)).accounts, store.accounts);
  await store.forget(other.index);
  assert.deepEqual((await OTPStore.create(storage)).accounts, [
    account({label: 'Updated label'}),
  ]);
});

test('only account metadata survives, without card identity, PINs, secrets or codes', async context => {
  const input = account({
    id: '11223344',
    publicKey: `04${'11'.repeat(64)}`,
    installed: true,
    authorized: true,
    secret: 'SENSITIVE',
    code: '654321',
    pin: '123456',
  });
  const storage = storageFixture(context, [input]);
  const store = await OTPStore.create(storage);
  assert.deepEqual(store.accounts, [account()]);
  await store.save([input]);
  input.label = 'Changed outside the store';
  assert.deepEqual(store.accounts, [account()]);
  assert.deepEqual(storage.set.mock.calls.at(-1).arguments, [
    'otpAccounts',
    [account()],
  ]);
});

test('indices normalize and deduplicate before selecting or forgetting', async context => {
  const canonical = account({
    index: `f201${'ab'.repeat(8)}`,
  });
  const upper = {
    ...canonical,
    index: canonical.index.toUpperCase(),
  };
  const store = await OTPStore.create(
    storageFixture(context, [canonical, upper]),
  );
  assert.deepEqual(store.accounts, [canonical]);
  await store.forget(upper.index);
  assert.deepEqual(store.accounts, []);
});

test('malformed cached records are skipped without hiding valid accounts', async context => {
  for (const initial of [null, undefined, {}, 'invalid'])
    assert.deepEqual(
      (await OTPStore.create(storageFixture(context, initial))).accounts,
      [],
    );
  const invalid = [
    null,
    {},
    ...[
      {index: `f101${'12'.repeat(8)}`},
      {index: 'f20100'},
      {keyIndex: `0514${'34'.repeat(8)}`},
      {keyIndex: `0101${'34'.repeat(8)}`},
      {label: null},
      {algorithm: 'MD5'},
      {digits: 7},
      {period: 0},
      {period: 32768},
      {period: 1.5},
      {period: '30'},
    ].map(account),
  ];
  const storage = storageFixture(context, [...invalid, account()]);
  const store = await OTPStore.create(storage);
  assert.deepEqual(store.accounts, [account()]);
  assert.equal(storage.set.mock.callCount(), 0);
  await assert.rejects(
    store.save([account({label: 'new'}), invalid[2]]),
    /Invalid OTP account metadata/,
  );
  assert.deepEqual(store.accounts, [account()]);
});

test('merging and forgetting accounts notify observers', async context => {
  const store = await OTPStore.create(storageFixture(context));
  const changes = [];
  const dispose = reaction(
    () => store.accounts,
    accounts => changes.push(accounts),
  );
  await store.save([account()]);
  await store.save([account({label: 'Updated'})]);
  await store.forget(account().index);
  dispose();
  assert.deepEqual(changes, [[account()], [account({label: 'Updated'})], []]);
});

test('concurrent merges and forgetting remain ordered across a pending write', async context => {
  const storage = storageFixture(context);
  const store = await OTPStore.create(storage);
  const pending = Promise.withResolvers();
  const set = storage.set;
  let active = 0,
    writes = 0;
  storage.set = context.mock.fn(async (...args) => {
    assert.equal(active++, 0);
    if (writes++ === 0) await pending.promise;
    await set(...args);
    active--;
  });
  const first = store.save([account()]);
  await setImmediate();
  const other = account({index: `f201${'56'.repeat(8)}`});
  const second = store.save([other]);
  const removal = store.forget(account().index);
  await setImmediate();
  assert.equal(writes, 1);
  pending.resolve();
  await Promise.all([first, second, removal]);
  assert.deepEqual((await OTPStore.create(storage)).accounts, [other]);
});

test('storage failures surface while later writes preserve cached accounts', async context => {
  const storage = storageFixture(context);
  const store = await OTPStore.create(storage);
  const failure = new Error('Storage unavailable');
  storage.set.mock.mockImplementationOnce(async () => {
    throw failure;
  });
  await assert.rejects(store.save([account()]), failure);
  assert.deepEqual(store.accounts, [account()]);
  await store.save([]);
  assert.deepEqual((await OTPStore.create(storage)).accounts, [account()]);
  storage.get.mock.mockImplementationOnce(async () => {
    throw failure;
  });
  await assert.rejects(OTPStore.create(storage), failure);
});
