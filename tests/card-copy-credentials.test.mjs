import assert from 'node:assert/strict';
import {test} from 'node:test';

import {CardBackupSession} from '../.bld/app/@components/views/safe/@card/card-backup-session.js';
import {AppletISOError} from '../.bld/app/@lib/applet.js';
import {CBORAppletError} from '../.bld/app/@lib/cbor-applet.js';
import {credential} from './helpers/security-key-credential.mjs';

const PIN = 'Secret-42';
const hex = value => Buffer.from(value).toString('hex');
const bytes = value => Uint8Array.from(Buffer.from(value, 'hex'));
const signal = () => new AbortController().signal;
const progress = () => {};

function card(id, entries) {
  const records = new Map(
    entries.map(item => [item.index, structuredClone(item)]),
  );
  const calls = [];
  return {
    records,
    calls,
    hello: {
      version: 1,
      id: bytes(`0000000${id}`),
      publicKey: Uint8Array.from([4, ...new Array(64).fill(id)]),
      bundle: new Uint8Array(32).fill(1),
      pins: {access: 5, secret: 5},
    },
    async authenticate(request) {
      calls.push(['authenticate']);
      assert.deepEqual(request, {secret: true, pin: PIN});
    },
    async list() {
      return {
        items: [...records.values()].map(({index, key, alias, secret}) => ({
          index: bytes(index),
          key: bytes(key),
          alias,
          secret,
        })),
      };
    },
    async view({index}) {
      calls.push(['view', hex(index)]);
      const item = records.get(hex(index));
      if (!item) throw new CBORAppletError({code: 'NOT_FOUND'});
      return {key: bytes(item.key), alias: item.alias, secret: item.secret};
    },
    async get({index}) {
      calls.push(['get', hex(index)]);
      const item = records.get(hex(index));
      assert.equal(item.secret, false, 'never read Secret plaintext');
      this.afterGet?.();
      return {data: bytes(item.data)};
    },
    async exportItem({index}) {
      calls.push(['export', hex(index)]);
      const item = records.get(hex(index));
      return {
        key: bytes(item.key),
        alias: item.alias,
        data: new TextEncoder().encode(JSON.stringify(item)),
      };
    },
    async importItem(request) {
      const index = hex(request.index);
      calls.push(['import', index]);
      const incoming = JSON.parse(new TextDecoder().decode(request.data));
      assert.equal(incoming.index, index);
      assert.equal(incoming.key, hex(request.key));
      assert.equal(incoming.alias, request.alias);
      const current = records.get(index);
      if (current) {
        try {
          assert.deepEqual(current, incoming);
        } catch {
          throw new AppletISOError(
            'Conflicting item',
            0x6985,
            new Uint8Array(),
          );
        }
      } else {
        records.set(index, incoming);
      }
      this.afterImport?.();
    },
  };
}

async function ready(sourceEntries, targetEntries) {
  const source = card(1, sourceEntries);
  const target = card(2, targetEntries);
  const session = new CardBackupSession();
  await session.readSource(source, source.hello, signal());
  await session.addTarget(target.hello);
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  return {source, target, session};
}

test('Copy skips identical credentials, adds distinct indices and keeps destination-only records', async () => {
  const first = credential(1);
  const second = credential(2);
  const third = credential(3);
  const {session, target} = await ready([first, second], [first, third]);
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.equal(session.backup.complete, true);
  assert.deepEqual([...target.records.values()], [first, third, second]);
  assert.deepEqual(
    target.calls.filter(([name]) => name === 'import'),
    [['import', second.index]],
  );
});

test('Copy preserves a conflicting credential while copying independent records', async () => {
  const first = credential(1);
  const conflicting = credential(1, {fields: [[6, 'other name']]});
  const second = credential(2);
  const {session, target} = await ready([first, second], [conflicting]);
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.equal(session.backup.complete, false);
  assert.equal(session.backup.targets[0].items[0].conflict, true);
  assert.equal(session.backup.targets[0].items[0].imported, false);
  assert.equal(session.backup.targets[0].items[1].imported, true);
  assert.deepEqual([...target.records.values()], [conflicting, second]);
  assert.deepEqual(
    target.calls.filter(([name]) => name === 'import'),
    [['import', second.index]],
  );
});

test('Copy skips identical key and payload without overwriting the destination alias', async () => {
  const first = credential(1, {alias: 'Source'});
  const existing = {...first, alias: 'Destination'};
  const {session, target} = await ready([first], [existing]);
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.equal(session.backup.complete, true);
  assert.equal(
    target.calls.some(([name]) => name === 'import'),
    false,
  );
  assert.deepEqual(target.records.get(first.index), existing);
});

test('Copy refuses a Secret credential index without reading its body', async () => {
  const first = credential(1);
  const {session, target} = await ready([first], [{...first, secret: true}]);
  await assert.rejects(
    session.importItems(target, target.hello, PIN, signal(), progress),
    /invalid Security Key credential/,
  );
  assert.equal(session.backup.importStarted, false);
  assert.deepEqual(
    target.calls.map(([name]) => name),
    ['authenticate', 'view'],
  );
});

test('cancellation during credential comparison does not mark it imported or send a write', async () => {
  const first = credential(1);
  const {session, target} = await ready([first], [first]);
  const controller = new AbortController();
  target.afterGet = () => controller.abort();
  await assert.rejects(
    session.importItems(target, target.hello, PIN, controller.signal, progress),
    /cancelled/,
  );
  assert.equal(session.backup.targets[0].items[0].imported, false);
  assert.equal(session.backup.importStarted, false);
  assert.equal(
    target.calls.some(([name]) => name === 'import'),
    false,
  );
});

test('cancellation after a credential import preserves its acknowledgement and sends no next command', async () => {
  const first = credential(1);
  const second = credential(2);
  const {session, target} = await ready([first, second], []);
  const controller = new AbortController();
  target.afterImport = () => controller.abort();
  await assert.rejects(
    session.importItems(target, target.hello, PIN, controller.signal, progress),
    /cancelled/,
  );
  assert.deepEqual(
    session.backup.targets[0].items.map(item => item.imported),
    [true, false],
  );
  assert.deepEqual(
    target.calls.filter(([name]) => name === 'view' || name === 'import'),
    [
      ['view', first.index],
      ['import', first.index],
    ],
  );
});

test('Copy keeps same-RP same-user registrations from different scopes as independent records', async () => {
  const first = credential(1, {scope: 1});
  const second = credential(2, {scope: 2});
  const {session, source, target} = await ready([first, second], []);
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.equal(session.backup.complete, true);
  assert.deepEqual([...target.records.values()], [first, second]);
  assert.deepEqual(
    target.calls
      .filter(([name]) => name === 'import')
      .map(([, index]) => index),
    [first.index, second.index],
  );
  assert.ok(
    [...source.calls, ...target.calls].every(
      ([name]) => !name.toLowerCase().includes('grant'),
    ),
  );
});

test('Copy rejects old and malformed source records before exporting them', async () => {
  for (const item of [
    credential(1, {fields: [[10, undefined]]}),
    credential(1, {fields: [[10, new Uint8Array(31)]]}),
    credential(1, {key: '11'.repeat(32)}),
    credential(1, {secret: true}),
  ]) {
    const source = card(1, [item]);
    const target = card(2, []);
    const session = new CardBackupSession();
    await session.readSource(source, source.hello, signal());
    await session.addTarget(target.hello);
    await session.confirmTargets();
    await assert.rejects(
      session.exportItems(source, source.hello, PIN, signal(), progress),
      /invalid Security Key credential/,
    );
    assert.equal(
      source.calls.some(([name]) => name === 'export'),
      false,
    );
    if (item.secret)
      assert.equal(
        source.calls.some(([name]) => name === 'get'),
        false,
      );
    assert.equal(session.backup.targets[0].items[0].exported, undefined);
    assert.equal(session.backup.complete, false);
    assert.equal(session.backup.importStarted, false);
  }
});

test('Copy rejects malformed destination data without replacing or marking it imported', async () => {
  const first = credential(1);
  const existing = credential(1, {fields: [[10, undefined]]});
  const {session, target} = await ready([first], [existing]);
  await assert.rejects(
    session.importItems(target, target.hello, PIN, signal(), progress),
    /invalid Security Key credential/,
  );
  assert.deepEqual(target.records.get(first.index), existing);
  assert.equal(
    target.calls.some(([name]) => name === 'import'),
    false,
  );
  assert.equal(session.backup.targets[0].items[0].imported, false);
  assert.equal(session.backup.importStarted, false);
});

test('a later invalid source preserves earlier acknowledged exports for the next attempt', async () => {
  const first = credential(1);
  const second = credential(2, {fields: [[10, undefined]]});
  const source = card(1, [first, second]);
  const target = card(2, []);
  const session = new CardBackupSession();
  await session.readSource(source, source.hello, signal());
  await session.addTarget(target.hello);
  await session.confirmTargets();
  await assert.rejects(
    session.exportItems(source, source.hello, PIN, signal(), progress),
    /invalid Security Key credential/,
  );
  assert.ok(session.backup.targets[0].items[0].exported);
  assert.equal(session.backup.targets[0].items[1].exported, undefined);
  source.records.set(second.index, credential(2));
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  assert.deepEqual(
    source.calls
      .filter(([name]) => name === 'export')
      .map(([, index]) => index),
    [first.index, second.index],
  );
});

test('Copy validates export metadata as well as the plaintext observation', async () => {
  const first = credential(1);
  const source = card(1, [first]);
  const target = card(2, []);
  const session = new CardBackupSession();
  await session.readSource(source, source.hello, signal());
  await session.addTarget(target.hello);
  await session.confirmTargets();
  const exportItem = source.exportItem;
  source.exportItem = async function (request) {
    return {...(await exportItem.call(this, request)), key: new Uint8Array(64)};
  };
  await assert.rejects(
    session.exportItems(source, source.hello, PIN, signal(), progress),
    /invalid Security Key credential/,
  );
  assert.equal(session.backup.targets[0].items[0].exported, undefined);
});
