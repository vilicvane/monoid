import assert from 'node:assert/strict';
import {test} from 'node:test';

import {CardBackupSession} from '../.bld/app/@components/views/safe/@card/card-backup-session.js';
import {mergeCardItemData} from '../.bld/app/@components/views/safe/card-item-merge.js';
import {validateCardOTPItem} from '../.bld/app/@components/views/safe/card-otp.js';
import {
  formatCardResourceCount,
  getCardResourceGroups,
} from '../.bld/app/@components/views/safe/card-resource-groups.js';
import {isCardKeyItem} from '../.bld/app/@components/views/safe/common.js';
import {scanCardItems} from '../.bld/app/@components/views/safe/scan-card.js';
import {
  CardItemExistsError,
  CardItemNotFoundError,
} from '../.bld/app/@lib/cbor-applet.js';
import {removeItems} from '../.bld/app/@lib/monoid/item-operations.js';
import {CardStore} from '../.bld/app/@services/card-store.js';

const KEY_INDEX = '05140000000000000001';
const ACCOUNT_INDEX = 'f2010000000000000001';
const key = {index: KEY_INDEX, type: 'hmac', secret: true};
const account = {
  index: ACCOUNT_INDEX,
  type: -3583,
  alias: 'Example: alice',
  secret: true,
  metadata: '010106001e',
};
const bytes = value => Uint8Array.from(Buffer.from(value, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const signal = () => new AbortController().signal;

test('OTP validation accepts public configuration on one secret item without data', () => {
  assert.doesNotThrow(() => validateCardOTPItem(account));
  for (const override of [
    {index: 'f20100'},
    {index: KEY_INDEX},
    {secret: false},
    {metadata: undefined},
    {metadata: '0g'},
    {metadata: '0101060000'},
    {metadata: '020106001e'},
    {metadata: '010406001e'},
  ])
    assert.throws(
      () => validateCardOTPItem({...account, ...override}),
      /invalid OTP account/,
    );
});

test('OTP and built-in HMAC resources are independent for selection and deletion', async () => {
  const groups = getCardResourceGroups([account, key]);
  assert.deepEqual(groups, [
    {item: account, items: [account]},
    {item: key, items: [key]},
  ]);
  assert.equal(formatCardResourceCount(groups), '2');
  assert.equal(isCardKeyItem(account), false);
  assert.equal(isCardKeyItem(key), false);
  const removed = [];
  await removeItems(
    {
      remove: async ({index}) => {
        removed.push(hex(index));
        return {removed: true};
      },
    },
    new Set(groups[0].items.map(item => item.index)),
    signal(),
  );
  assert.deepEqual(removed, [ACCOUNT_INDEX]);
});

test('same OTP index pins its secret and conflicts only on configuration when merging', () => {
  assert.equal(
    mergeCardItemData(account, {...account, alias: 'Other'}),
    account,
  );
  assert.equal(
    mergeCardItemData({...account, data: 'aa'}, {...account, data: 'bb'}).data,
    'aa',
    'ciphertexts do not compare plaintext secrets',
  );
  assert.throws(
    () => mergeCardItemData(account, {...account, metadata: '010108001e'}),
    /conflicting OTP data/,
  );
});

test('Safe scan uses only the list for OTP, skips incompatible items and keeps a single-item snapshot', async () => {
  const incompatible = {
    ...account,
    index: 'f2010000000000000002',
    secret: false,
  };
  const items = await scanCardItems(
    {
      list: async () => ({
        items: [account, key, incompatible].map(
          ({index, type, alias, secret, metadata}) => ({
            index: bytes(index),
            type,
            alias,
            secret,
            metadata: metadata && bytes(metadata),
          }),
        ),
      }),
      get: () => assert.fail('OTP must not use Get'),
      viewKey: () => assert.fail('OTP must not derive a wallet key'),
    },
    () => {},
  );
  assert.deepEqual(items, [account, key]);
  const state = new CardStore().set({
    id: '11223344',
    publicKey: `04${'11'.repeat(64)}`,
    bundle: false,
    items,
  });
  assert.deepEqual(state.snapshot().items, [account, key]);
  assert.equal(getCardResourceGroups(state.snapshot().items).length, 2);
});

function copyFixture() {
  const hello = number => ({
    id: bytes(`1122330${number}`),
    publicKey: bytes(`04${String(number).repeat(128)}`),
    bundle: false,
    authority: false,
    pins: {access: 5, secret: 5},
  });
  const entries = [account, key];
  const exports = [];
  const source = {
    hello: hello(1),
    authenticate: async () => {},
    list: async () => ({
      items: entries.map(({index, type, alias, secret, metadata}) => ({
        index: bytes(index),
        type,
        alias,
        secret,
        metadata: metadata && bytes(metadata),
      })),
    }),
    view: async ({index}) => {
      const item = entries.find(item => item.index === hex(index));
      return {
        secret: item.secret,
        alias: item.alias,
        metadata: item.metadata && bytes(item.metadata),
      };
    },
    get: async () => assert.fail('OTP plaintext must never be requested'),
    exportItem: async ({index}) => {
      exports.push(hex(index));
      const item = entries.find(item => item.index === hex(index));
      return {
        metadata: item.metadata && bytes(item.metadata),
        alias: item.alias,
        data: bytes('aa'),
      };
    },
  };
  const target = {
    hello: hello(2),
    records: new Map(),
    calls: [],
    authenticate: async () => {},
    async view({index}) {
      const item = this.records.get(hex(index));
      if (!item) throw new CardItemNotFoundError({code: 'NOT_FOUND'});
      return {
        secret: item.secret,
        alias: item.alias,
        metadata: item.metadata && bytes(item.metadata),
      };
    },
    async get() {
      assert.fail('OTP plaintext must never be requested');
    },
    async importItem({index}) {
      const id = hex(index);
      this.calls.push(id);
      if (this.records.has(id)) throw new CardItemExistsError({code: 'EXISTS'});
      this.records.set(
        id,
        structuredClone(entries.find(item => item.index === id)),
      );
      await this.afterImport?.();
    },
  };
  return {source, target, exports};
}

async function prepareCopy(source, target, indexes = [ACCOUNT_INDEX]) {
  const session = new CardBackupSession();
  await session.readSource(source, source.hello, signal(), indexes);
  await session.addTarget(target.hello);
  await session.confirmTargets();
  await session.exportItems(
    source,
    source.hello,
    'Secret-42',
    signal(),
    () => {},
  );
  return session;
}
const importCopy = (session, target) =>
  session.importItems(target, target.hello, 'Secret-42', signal(), () => {});

test('Copy selects, exports and imports an OTP account as one secret item', async () => {
  const {source, target, exports} = copyFixture();
  const session = await prepareCopy(source, target);
  assert.deepEqual(
    session.backup.items.filter(item => item.selected).map(item => item.index),
    [ACCOUNT_INDEX],
  );
  assert.deepEqual(exports, [ACCOUNT_INDEX]);
  assert.equal(
    session.backup.targets[0].items[0].exported.plaintext,
    undefined,
  );
  await importCopy(session, target);
  assert.deepEqual(target.calls, [ACCOUNT_INDEX]);
  assert.deepEqual([...target.records.values()], [account]);
  assert.equal(session.backup.complete, true);
});

test('Copy accepts the same OTP configuration while preserving the destination alias', async () => {
  const {source, target} = copyFixture();
  const existing = {...account, alias: 'Destination'};
  target.records.set(ACCOUNT_INDEX, existing);
  const session = await prepareCopy(source, target);
  await importCopy(session, target);
  assert.deepEqual(target.calls, []);
  assert.equal(target.records.get(ACCOUNT_INDEX), existing);
  assert.equal(session.backup.complete, true);
});

test('Copy preserves conflicting OTP configurations and unprotected legacy items', async () => {
  for (const override of [{metadata: '010108001e'}, {secret: false}]) {
    const {source, target} = copyFixture();
    const existing = {...account, ...override};
    target.records.set(ACCOUNT_INDEX, existing);
    const session = await prepareCopy(source, target);
    await importCopy(session, target);
    assert.deepEqual(target.calls, []);
    assert.equal(target.records.get(ACCOUNT_INDEX), existing);
    if (override.secret === false) {
      assert.deepEqual(session.backup.targets[0].items, []);
    } else {
      assert.equal(session.backup.complete, false);
      assert.equal(session.backup.targets[0].items[0].conflict, true);
    }
  }
});

test('Copy catches configuration changes between listing and encrypted export', async () => {
  const {source, target} = copyFixture();
  const exportItem = source.exportItem;
  source.exportItem = async request => ({
    ...(await exportItem(request)),
    metadata: bytes('010108001e'),
  });
  await assert.rejects(prepareCopy(source, target), /conflicting OTP data/);
  assert.deepEqual(target.calls, []);
});

test('Copy reconciles an uncertain OTP import with View on the next explicit attempt', async () => {
  const {source, target} = copyFixture();
  const session = await prepareCopy(source, target);
  target.afterImport = () => {
    throw new Error('Lost response');
  };
  await assert.rejects(importCopy(session, target), /Lost response/);
  assert.deepEqual(target.calls, [ACCOUNT_INDEX]);
  assert.equal(session.backup.complete, false);
  await importCopy(session, target);
  assert.deepEqual(target.calls, [ACCOUNT_INDEX]);
  assert.equal(session.backup.complete, true);
});
