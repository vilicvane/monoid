import assert from 'node:assert/strict';
import {test} from 'node:test';

import {CardBackupSession} from '../.bld/app/@components/views/safe/@card/card-backup-session.js';
import {mergeCardItemData} from '../.bld/app/@components/views/safe/card-item-merge.js';
import {
  assertCardOTPAssociations,
  filterCardOTPAssociations,
  readCardOTPKeyIndex,
  validateCardOTPItem,
} from '../.bld/app/@components/views/safe/card-otp.js';
import {deleteCardResources} from '../.bld/app/@components/views/safe/card-resource-delete.js';
import {
  formatCardResourceCount,
  getCardResourceGroups,
} from '../.bld/app/@components/views/safe/card-resource-groups.js';
import {isCardKeyItem} from '../.bld/app/@components/views/safe/common.js';
import {scanCardItems} from '../.bld/app/@components/views/safe/scan-card.js';
import {AppletISOError} from '../.bld/app/@lib/applet.js';
import {CBORAppletError} from '../.bld/app/@lib/cbor-applet.js';
import {CardStore} from '../.bld/app/@services/card-store.js';

const KEY_INDEX = '05140000000000000001';
const OTHER_KEY_INDEX = '05140000000000000002';
const ACCOUNT_INDEX = 'f2010000000000000001';
const key = {index: KEY_INDEX, type: 'hmac', secret: true};
const account = {
  index: ACCOUNT_INDEX,
  type: 0xf201,
  alias: 'Example: alice',
  secret: false,
  metadata: '010106001e',
  data: KEY_INDEX,
  otpKeyIndex: KEY_INDEX,
};
const bytes = value => Uint8Array.from(Buffer.from(value, 'hex'));
const hex = value => Buffer.from(value).toString('hex');

test('OTP records validate configuration and HMAC references without reading secrets', async () => {
  const calls = [];
  assert.equal(validateCardOTPItem(account), KEY_INDEX);
  assert.equal(
    await readCardOTPKeyIndex(
      {
        async get({index}) {
          calls.push(hex(index));
          return {data: bytes(KEY_INDEX)};
        },
      },
      account,
    ),
    KEY_INDEX,
  );
  assert.deepEqual(calls, [ACCOUNT_INDEX]);
  for (const change of [
    {secret: true},
    {metadata: '010107001e'},
    {metadata: '0101060000'},
    {metadata: '0101068000'},
    {metadata: 'gg'},
    {data: '0500' + '00'.repeat(8)},
    {data: '0240' + '00'.repeat(8)},
    {data: '051400'},
    {otpKeyIndex: OTHER_KEY_INDEX},
  ])
    assert.throws(
      () => validateCardOTPItem({...account, ...change}),
      /invalid OTP account/,
    );
  await assert.rejects(
    readCardOTPKeyIndex(
      {get: () => assert.fail('Secret metadata must not be read')},
      {...account, secret: true},
    ),
    /invalid OTP account/,
  );
});

test('an OTP account must reference a present Secret HMAC key', () => {
  assertCardOTPAssociations([key, account]);
  for (const items of [
    [account],
    [{...key, secret: false}, account],
    [key, {...account, secret: true}],
    [key, {...account, otpKeyIndex: undefined}],
    [key, {...account, otpKeyIndex: '03010000000000000001'}],
  ])
    assert.throws(
      () => assertCardOTPAssociations(items),
      /associated key is missing|invalid OTP/,
    );
});

test('filtering incompatible OTP associations retains valid accounts and independent keys', () => {
  const orphan = {
    ...account,
    index: 'f2010000000000000002',
    otpKeyIndex: OTHER_KEY_INDEX,
  };
  const unsupported = {
    ...account,
    index: 'f2010000000000000003',
    otpKeyIndex: undefined,
  };
  assert.deepEqual(
    filterCardOTPAssociations([orphan, key, unsupported, account]),
    [key, account],
  );
});

test('Safe scan skips malformed and orphan OTP accounts and never reads protected metadata', async () => {
  const invalid = {
    ...account,
    index: 'f2010000000000000002',
    metadata: '020106001e',
  };
  const orphan = {
    ...account,
    index: 'f2010000000000000003',
    otpKeyIndex: OTHER_KEY_INDEX,
  };
  const protectedRecord = {
    ...account,
    index: 'f2010000000000000004',
    secret: true,
  };
  const entries = [invalid, key, orphan, protectedRecord, account];
  const reads = [];
  const result = await scanCardItems(
    {
      list: async () => ({
        items: entries.map(({index, type, alias, secret, metadata}) => ({
          index: bytes(index),
          type,
          alias,
          secret,
          metadata: metadata && bytes(metadata),
        })),
      }),
      get: async ({index}) => {
        reads.push(hex(index));
        assert.notEqual(hex(index), protectedRecord.index);
        return {
          data: bytes(
            hex(index) === orphan.index ? OTHER_KEY_INDEX : KEY_INDEX,
          ),
        };
      },
    },
    () => {},
  );
  assert.deepEqual(
    result.map(item => item.index),
    [KEY_INDEX, ACCOUNT_INDEX],
  );
  assert.ok(!reads.includes(protectedRecord.index));
});

test('accounts sharing a secret form one selection group and delete before the secret', async () => {
  const second = {...account, index: 'f2010000000000000002'};
  const groups = getCardResourceGroups([account, key, second]);
  assert.deepEqual(groups, [{item: key, items: [key, account, second]}]);
  assert.equal(formatCardResourceCount(groups), '1+2');
  assert.equal(
    formatCardResourceCount(groups, () => false),
    '0/3',
  );
  assert.equal(isCardKeyItem(key), false, 'HMAC is not a wallet key');
  assert.equal(isCardKeyItem(account), false);
  const deleted = [];
  const pending = new Set(
    groups.flatMap(group => [...group.items].reverse().map(item => item.index)),
  );
  await deleteCardResources(
    {remove: async ({index}) => deleted.push(hex(index))},
    pending,
    new AbortController().signal,
    () => {},
  );
  assert.deepEqual(deleted, [second.index, account.index, key.index]);
  assert.throws(
    () => getCardResourceGroups([account]),
    /associated key is missing/,
  );
});

test('matching OTP records retain display aliases but configuration or reference collisions fail', () => {
  assert.equal(
    mergeCardItemData(account, {...account, alias: 'Other'}),
    account,
  );
  assert.throws(
    () => mergeCardItemData(account, {...account, metadata: '010108001e'}),
    /conflicting OTP data/,
  );
  assert.throws(
    () =>
      mergeCardItemData(account, {
        ...account,
        data: OTHER_KEY_INDEX,
        otpKeyIndex: OTHER_KEY_INDEX,
      }),
    /conflicting OTP data/,
  );
});

test('Safe Card scan reads public OTP references without deriving HMAC and snapshots preserve grouping', async () => {
  const calls = [];
  const items = await scanCardItems(
    {
      list: async () => ({
        items: [account, key].map(({index, type, alias, secret, metadata}) => ({
          index: bytes(index),
          type,
          alias,
          secret,
          metadata: metadata && bytes(metadata),
        })),
      }),
      get: async ({index}) => {
        calls.push(hex(index));
        return {data: bytes(KEY_INDEX)};
      },
      viewKey: () => assert.fail('HMAC must not be treated as a wallet key'),
    },
    () => {},
  );
  assert.deepEqual(calls, [ACCOUNT_INDEX]);
  assert.equal(items[0].otpKeyIndex, KEY_INDEX);
  const state = new CardStore().set({
    id: '11223344',
    publicKey: '04' + '11'.repeat(64),
    bundle: false,
    items,
  });
  assert.equal(state.items[0].otpKeyIndex, KEY_INDEX);
  assert.equal(state.snapshot().items[0].otpKeyIndex, KEY_INDEX);
  assert.equal(getCardResourceGroups(state.snapshot().items).length, 1);
});

function copyFixture() {
  const hello = number => ({
    id: bytes(`1122330${number}`),
    publicKey: bytes('04' + String(number).repeat(128)),
    bundle: false,
    authority: false,
    pins: {access: 5, secret: 5},
  });
  const entries = [account, key];
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
        metadata: item.metadata && bytes(item.metadata),
      };
    },
    get: async ({index}) => {
      assert.equal(
        hex(index),
        ACCOUNT_INDEX,
        'only public metadata is readable',
      );
      return {data: bytes(KEY_INDEX)};
    },
    exportItem: async ({index}) => {
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
      if (!item) throw new CBORAppletError({code: 'NOT_FOUND'});
      return {
        secret: item.secret,
        metadata: item.metadata && bytes(item.metadata),
      };
    },
    async get({index}) {
      return {data: bytes(this.records.get(hex(index)).data)};
    },
    async importItem({index}) {
      const id = hex(index);
      this.calls.push(id);
      if (id === KEY_INDEX && this.conflictingKey)
        throw new AppletISOError('Conflicting data', 0x6985, new Uint8Array());
      this.records.set(
        id,
        structuredClone(entries.find(item => item.index === id)),
      );
    },
  };
  return {source, target};
}

test('Copy selecting an OTP account or its HMAC expands the pair and writes the secret first', async () => {
  for (const selected of [ACCOUNT_INDEX, KEY_INDEX]) {
    const {source, target} = copyFixture();
    const session = new CardBackupSession();
    const signal = new AbortController().signal;
    await session.readSource(source, source.hello, signal, [selected]);
    assert.deepEqual(
      session.backup.items
        .filter(item => item.selected)
        .map(item => item.index),
      [KEY_INDEX, ACCOUNT_INDEX],
    );
    await session.addTarget(target.hello);
    await session.confirmTargets();
    await session.exportItems(
      source,
      source.hello,
      'Secret-42',
      signal,
      () => {},
    );
    await session.importItems(
      target,
      target.hello,
      'Secret-42',
      signal,
      () => {},
    );
    assert.deepEqual(target.calls, [KEY_INDEX, ACCOUNT_INDEX]);
    assert.equal(session.backup.complete, true);
  }
});

test('Copy does not write an OTP account after its HMAC import conflicts', async () => {
  const {source, target} = copyFixture();
  target.conflictingKey = true;
  const session = new CardBackupSession();
  const signal = new AbortController().signal;
  await session.readSource(source, source.hello, signal);
  await session.addTarget(target.hello);
  await session.confirmTargets();
  await session.exportItems(
    source,
    source.hello,
    'Secret-42',
    signal,
    () => {},
  );
  await session.importItems(
    target,
    target.hello,
    'Secret-42',
    signal,
    () => {},
  );
  assert.deepEqual(target.calls, [KEY_INDEX]);
  assert.equal(target.records.size, 0);
  assert.equal(session.backup.complete, false);
  assert.ok(session.backup.targets[0].items.every(item => item.conflict));
});

test('Copy preserves an existing OTP account with conflicting configuration', async () => {
  const {source, target} = copyFixture();
  const existing = {...account, metadata: '010108001e'};
  target.records.set(ACCOUNT_INDEX, existing);
  const session = new CardBackupSession();
  const signal = new AbortController().signal;
  await session.readSource(source, source.hello, signal);
  await session.addTarget(target.hello);
  await session.confirmTargets();
  await session.exportItems(
    source,
    source.hello,
    'Secret-42',
    signal,
    () => {},
  );
  await session.importItems(
    target,
    target.hello,
    'Secret-42',
    signal,
    () => {},
  );
  assert.deepEqual(target.calls, [KEY_INDEX]);
  assert.equal(target.records.get(ACCOUNT_INDEX), existing);
  assert.equal(
    session.backup.targets[0].items.find(item => item.index === ACCOUNT_INDEX)
      .conflict,
    true,
  );
});
