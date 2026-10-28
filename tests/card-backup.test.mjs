import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  CardBackupSession,
  assertBackupCard,
  getBackupCardIdentity,
  initializeBackupTarget,
} from '../.bld/app/@components/views/safe/@card/card-backup-session.js';
import {
  decodeCardDerivationRecord,
  encodeCardDerivationRecord,
  getCardDerivationItemIndex,
} from '../.bld/app/@components/views/safe/card-derivations.js';
import {
  CBORAppletError,
  CardItemExistsError,
  CardItemNotFoundError,
} from '../.bld/app/@lib/cbor-applet.js';
import {initializeMonoidCard} from '../.bld/app/@lib/monoid/initialize-card.js';
import {ADDRESS_TYPES} from '../.bld/app/@lib/wallet-address.js';

const PIN = 'Safe-42';
const signal = () => new AbortController().signal;
const progress = () => {};
const hex = bytes => Buffer.from(bytes).toString('hex');
const bytes = value => Uint8Array.from(Buffer.from(value, 'hex'));
const index = number => bytes(`1234000000000000000${number}`);

function hello(identity, {accessPIN = 5, secretPIN = 5, ...overrides} = {}) {
  return {
    version: 1,
    id: bytes(`1000000${identity}`),
    publicKey: Uint8Array.from([4, ...new Array(64).fill(identity)]),
    bundle: false,
    authority: false,
    alias: false,
    allowPeerExtension: false,
    pins: {access: accessPIN, secret: secretPIN},
    ...overrides,
  };
}

function destination(identity) {
  return {
    hello: hello(identity),
    calls: [],
    records: new Map(),
    authentications: [],
    async authenticate(request) {
      this.authentications.push(request);
      assert.equal(request.secret, true);
      if (request.pin !== PIN) {
        throw new CBORAppletError({code: 'INVALID_PIN', tries: 4});
      }
    },
    async importItem(request) {
      this.calls.push(['importItem', structuredClone(request)]);
      assert.equal(
        request.data[0],
        request.senderPublicKey ? identity : 0x7f,
        'Ciphertext belongs to this recipient or its bundle',
      );
      await this.beforeImport?.(request);
      const key = hex(request.index);
      const existing = this.records.get(key);
      if (existing) {
        throw new CardItemExistsError({code: 'EXISTS'});
      } else {
        this.records.set(key, structuredClone(request));
      }
      await this.afterImport?.(request);
    },
    async view({index: itemIndex}) {
      this.calls.push(['view', {index: itemIndex}]);
      const record = this.records.get(hex(itemIndex));
      if (!record) throw new CardItemNotFoundError({code: 'NOT_FOUND'});
      return {
        metadata: record.metadata,
        alias: record.alias,
        secret:
          !hex(itemIndex).startsWith('0f01') &&
          hex(itemIndex) !== hex(index(2)),
      };
    },
    async get({index}) {
      this.calls.push(['get', {index}]);
      return {data: this.records.get(hex(index)).data.subarray(1)};
    },
    async list(request) {
      this.calls.push(['list', request]);
      return {
        items: [...this.records.values()].map(record => ({
          index: record.index,
        })),
      };
    },
  };
}

function fixture() {
  const items = [
    {index: index(1), type: 'seed', alias: 'List alias', secret: true},
    {index: index(2), secret: false},
    {index: index(3), type: 0x1234, alias: '', secret: true},
  ];
  const exports = new Map([
    [hex(index(1)), {data: new Uint8Array(160).fill(1)}],
    [
      hex(index(2)),
      {
        metadata: new Uint8Array(),
        alias: '',
        data: new Uint8Array(144).fill(2),
      },
    ],
    [
      hex(index(3)),
      {
        metadata: bytes('abcd'),
        alias: 'e\u0301',
        data: new Uint8Array(180).fill(3),
      },
    ],
  ]);
  const artifact = (itemIndex, recipientPublicKey) => {
    const exported = structuredClone(exports.get(hex(itemIndex)));
    exported.data[0] = recipientPublicKey[1];
    return exported;
  };
  const source = {
    hello: hello(1),
    calls: [],
    async list(request) {
      this.calls.push(['list', request]);
      return {items};
    },
    async authenticate(request) {
      this.calls.push(['authenticate', request]);
      if (request.pin !== PIN) {
        throw new CBORAppletError({code: 'INVALID_PIN', tries: 4});
      }
    },
    async get({index: itemIndex}) {
      this.calls.push(['get', {index: itemIndex}]);
      return {data: exports.get(hex(itemIndex)).data.subarray(1)};
    },
    async exportItem(request) {
      this.calls.push(['exportItem', structuredClone(request)]);
      await this.onExport?.(request);
      return artifact(
        request.index,
        request.recipientPublicKey ?? Uint8Array.of(4, 0x7f),
      );
    },
  };
  return {
    items,
    artifact,
    source,
    target: destination(2),
    secondTarget: destination(3),
  };
}

async function ready({multiple = false, bundle = false} = {}) {
  const {source, target, ...rest} = fixture();
  if (bundle) {
    for (const card of [source, target, rest.secondTarget])
      card.hello.bundle = new Uint8Array(32).fill(1);
  }
  const session = new CardBackupSession();
  await session.readSource(source, source.hello, signal());
  await session.addTarget(target.hello);
  if (multiple) await session.addTarget(rest.secondTarget.hello);
  await session.confirmTargets();
  return {source, target, session, ...rest};
}

for (const targetBundle of [false, new Uint8Array(32).fill(2)]) {
  test(`a bundled source rejects a ${targetBundle === false ? 'non-bundled' : 'different-bundle'} destination before export`, async () => {
    const {source, target} = fixture();
    source.hello.bundle = new Uint8Array(32).fill(1);
    target.hello.bundle = targetBundle;
    const session = new CardBackupSession();
    await session.readSource(source, source.hello, signal());

    await assert.rejects(session.addTarget(target.hello), /same bundle/);
    assert.deepEqual(session.backup.targets, []);
    assert.equal(session.backup.source.bundle, '01'.repeat(32));
    assert.equal(session.busy, false);
    assert.deepEqual(
      source.calls.map(([name]) => name),
      ['list', 'get'],
    );
  });
}

test('an asymmetric source can copy into an enrolled destination using its public key', async () => {
  const {source, target} = fixture();
  target.hello.bundle = new Uint8Array(32).fill(2);
  const session = new CardBackupSession();
  await session.readSource(source, source.hello, signal());
  await session.addTarget(target.hello);
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  await session.importItems(target, target.hello, PIN, signal(), progress);

  assert.equal(session.backup.complete, true);
  assert.equal(session.backup.source.bundle, false);
  assert.equal(session.backup.targets[0].bundle, '02'.repeat(32));
  for (const [name, request] of source.calls) {
    if (name === 'exportItem')
      assert.deepEqual(request.recipientPublicKey, target.hello.publicKey);
  }
  for (const [name, request] of target.calls) {
    if (name === 'importItem')
      assert.deepEqual(request.senderPublicKey, source.hello.publicKey);
  }
});

test('a same-bundle transfer omits asymmetric keys and verifies the live destination bundle before importing', async () => {
  const {source, target, items} = fixture();
  source.hello.bundle = new Uint8Array(32).fill(1);
  target.hello.bundle = new Uint8Array(32).fill(1);
  source.exportItem = async request => {
    source.calls.push(['exportItem', request]);
    return {data: Uint8Array.of(2, 3, 4)};
  };
  target.importItem = async request => {
    target.calls.push(['importItem', request]);
    target.records.set(hex(request.index), request);
  };
  const session = new CardBackupSession(cardSnapshot(source, items));
  await session.addTarget(target.hello);
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);

  for (const [name, request] of source.calls) {
    if (name === 'exportItem')
      assert.equal('recipientPublicKey' in request, false);
  }
  target.hello.bundle = new Uint8Array(32).fill(2);
  await assert.rejects(
    session.importItems(target, target.hello, PIN, signal(), progress),
    /same bundle/,
  );
  assert.deepEqual(target.calls, []);
  target.hello.bundle = new Uint8Array(32).fill(1);
  await session.importItems(target, target.hello, PIN, signal(), progress);
  for (const [name, request] of target.calls) {
    if (name === 'importItem')
      assert.equal('senderPublicKey' in request, false);
  }
  assert.equal(session.backup.complete, true);
});

test('Copy rejects changed source and destination IDs even when public keys match', async () => {
  const {session, source, target} = await ready();
  const originalId = source.hello.id;
  source.hello.id = bytes('55667788');
  await assert.rejects(
    session.exportItems(source, source.hello, PIN, signal(), progress),
    /Wrong card/,
  );
  assert.deepEqual(
    source.calls.map(([name]) => name),
    ['list', 'get'],
  );

  source.hello.id = originalId;
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  target.hello.id = bytes('55667788');
  await assert.rejects(
    session.importItems(target, target.hello, PIN, signal(), progress),
    /Wrong card/,
  );
  assert.deepEqual(target.calls, []);
});

test('a changed source bundle is rejected before authentication or export', async () => {
  const {session, source} = await ready();
  source.hello.bundle = new Uint8Array(32).fill(1);
  await assert.rejects(
    session.exportItems(source, source.hello, PIN, signal(), progress),
    new RegExp(
      `Card bundle changed, scan card ${session.backup.source.id} again`,
    ),
  );
  assert.deepEqual(
    source.calls.map(([name]) => name),
    ['list', 'get'],
  );
  assert.ok(
    session.backup.targets.every(target =>
      target.items.every(item => !item.exported),
    ),
  );
  assert.equal(session.busy, false);
});

function cardSnapshot(source, items) {
  return {
    id: hex(source.hello.id),
    publicKey: hex(source.hello.publicKey),
    bundle: source.hello.bundle === false ? false : hex(source.hello.bundle),
    items: items.map(item => ({
      index: hex(item.index),
      ...(item.type !== undefined && {type: item.type}),
      ...(item.alias !== undefined && {alias: item.alias}),
      ...(item.metadata !== undefined && {metadata: hex(item.metadata)}),
      ...(item.derivationRecord !== undefined && {
        derivationRecord: structuredClone(item.derivationRecord),
      }),
      secret: item.secret,
    })),
  };
}

test('a scanned Card snapshot starts at destination selection and exports without another source List', async () => {
  const {source, target, items} = fixture();
  const selected = [hex(index(1)), hex(index(2))];
  const session = new CardBackupSession(cardSnapshot(source, items), selected);
  assert.deepEqual(source.calls, []);
  assert.deepEqual(
    session.backup.items.filter(item => item.selected).map(item => item.index),
    selected,
  );
  assert.deepEqual(session.backup.targets, []);
  assert.equal(session.backup.importStarted, false);
  await session.addTarget(target.hello);
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.deepEqual(
    source.calls.map(([method]) => method),
    ['authenticate', 'exportItem', 'get', 'exportItem'],
  );
  assert.deepEqual([...target.records.keys()], selected);
  assert.equal(session.backup.complete, true);
});

test('copy selection and the scanned Card snapshot do not share mutable item state', async () => {
  const {source, items} = fixture();
  const snapshot = cardSnapshot(source, items);
  snapshot.items[0].metadata = 'abcd';
  snapshot.items[0].ref = {publicKey: 'public-only', address: 'saved-address'};
  const original = structuredClone(snapshot);
  const session = new CardBackupSession(snapshot, [hex(index(1))]);
  await session.reset(snapshot, [hex(index(2))]);
  assert.deepEqual(snapshot, original);
  assert.equal(session.backup.items[0].metadata, 'abcd');
  assert.equal(Object.hasOwn(session.backup.items[0], 'ref'), false);
  const copy = structuredClone(session.backup);
  snapshot.id = 'ffffffff';
  snapshot.publicKey = hex(hello(3).publicKey);
  snapshot.items[0].alias = 'Changed outside copy';
  snapshot.items[0].secret = false;
  snapshot.items[0].index = hex(index(4));
  snapshot.items.push({index: hex(index(5)), secret: true});
  assert.deepEqual(session.backup, copy);
});

function groupedFixture({type = 'seed', wallets} = {}) {
  const state = fixture();
  const prefix = {seed: '0240', secp256k1: '0301', ed25519: '0401'}[type];
  const rootIndex = `${prefix}0000000000000001`;
  const orphanRootIndex = `${prefix}0000000000000002`;
  const wallet = {
    addressType: 'evm',
    seed: ADDRESS_TYPES.evm.seed,
    curve: ADDRESS_TYPES.evm.curve,
    path: ADDRESS_TYPES.evm.path(0),
  };
  const record = index => ({index, wallets: wallets ?? [{...wallet}]});
  const attachment = sourceIndex => ({
    index: bytes(getCardDerivationItemIndex(sourceIndex)),
    metadata: bytes(sourceIndex),
    secret: false,
    derivationRecord: record(sourceIndex),
  });
  const root = {index: bytes(rootIndex), type, secret: true};
  const companion = attachment(rootIndex);
  const orphan = attachment(orphanRootIndex);
  // Deliberately list the companion first: transfer must still import its root
  // before the attached record, while the orphan remains a standalone item.
  state.items.splice(0, state.items.length, companion, root, orphan);
  const records = new Map(
    [companion, orphan].map(item => [
      hex(item.index),
      encodeCardDerivationRecord(item.derivationRecord),
    ]),
  );
  state.source.get = async function (request) {
    this.calls.push(['get', structuredClone(request)]);
    await this.onGet?.(request);
    return {data: records.get(hex(request.index))};
  };
  state.source.exportItem = async function (request) {
    this.calls.push(['exportItem', structuredClone(request)]);
    await this.onExport?.(request);
    const item = state.items.find(
      item => hex(item.index) === hex(request.index),
    );
    const payload = records.get(hex(item.index)) ?? item.index;
    const data = Uint8Array.from([request.recipientPublicKey[1], ...payload]);
    return {
      ...(item.metadata !== undefined && {metadata: item.metadata}),
      data,
    };
  };
  return {...state, root, companion, orphan, records};
}

for (const selection of ['root', 'companion']) {
  test(`a scanned Card ${selection} selection includes the complete linked group without sharing metadata state`, () => {
    const {source, items, root, companion, orphan} = groupedFixture();
    const snapshot = cardSnapshot(source, items);
    const selectedIndex = hex(
      selection === 'root' ? root.index : companion.index,
    );
    const session = new CardBackupSession(snapshot, [selectedIndex]);
    assert.deepEqual(
      session.backup.items
        .filter(item => item.selected)
        .map(item => item.index),
      [hex(root.index), hex(companion.index)],
    );
    assert.equal(
      session.backup.items.find(item => item.index === hex(orphan.index))
        .selected,
      false,
    );
    const before = structuredClone(session.backup);
    snapshot.items[0].derivationRecord.wallets[0].path =
      ADDRESS_TYPES.evm.path(9);
    assert.deepEqual(session.backup, before);
    assert.deepEqual(source.calls, []);
  });
}

test('direct Copy validates linked records with Get and transfers both physical items root first', async () => {
  const {source, target, root, companion, orphan} = groupedFixture();
  const session = new CardBackupSession();
  await session.readSource(source, source.hello, signal(), [hex(root.index)]);
  assert.deepEqual(
    source.calls.map(([method]) => method),
    ['list', 'get', 'get'],
  );
  assert.deepEqual(
    source.calls
      .filter(([method]) => method === 'get')
      .map(([, request]) => hex(request.index)),
    [hex(companion.index), hex(orphan.index)],
  );
  assert.deepEqual(
    session.backup.items.find(item => item.index === hex(companion.index))
      .derivationRecord,
    companion.derivationRecord,
  );
  await session.addTarget(target.hello);
  await session.confirmTargets();
  assert.deepEqual(
    session.backup.targets[0].items.map(item => item.index),
    [hex(root.index), hex(companion.index)],
  );
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.deepEqual(
    source.calls
      .filter(([method]) => method === 'exportItem')
      .map(([, request]) => hex(request.index)),
    [hex(root.index), hex(companion.index)],
  );
  assert.deepEqual(
    [...target.records.keys()],
    [hex(root.index), hex(companion.index)],
  );
  assert.deepEqual(
    target.records.get(hex(companion.index)).metadata,
    root.index,
  );
  assert.equal(session.backup.complete, true);
});

test('reading a Copy source reports all opaque items with a fixed total', async () => {
  const {source} = groupedFixture();
  const session = new CardBackupSession();
  const reported = [];
  const beforeReads = [];
  const originalGet = source.get;
  source.get = function (request) {
    beforeReads.push([...reported.at(-1)]);
    return originalGet.call(this, request);
  };

  await session.readSource(
    source,
    source.hello,
    signal(),
    undefined,
    (...value) => reported.push(value),
  );

  assert.deepEqual(reported, [
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
  ]);
  assert.deepEqual(beforeReads, [
    [0, 3],
    [2, 3],
  ]);
  assert.ok(session.backup);
});

test('a Copy source reads public opaque data and reports every item', async () => {
  const {source} = fixture();
  const session = new CardBackupSession();
  const counts = [];
  await session.readSource(
    source,
    source.hello,
    signal(),
    undefined,
    (...count) => counts.push(count),
  );
  assert.deepEqual(counts, [
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
  ]);
  assert.equal(source.calls.filter(([name]) => name === 'get').length, 1);
});

test('cancelling a Copy source record read suppresses late progress and leaves the source unset', async () => {
  const {source} = groupedFixture();
  const session = new CardBackupSession();
  const controller = new AbortController();
  const reported = [];
  const originalGet = source.get;
  source.get = async function (request) {
    const result = await originalGet.call(this, request);
    controller.abort();
    return result;
  };

  await assert.rejects(
    session.readSource(
      source,
      source.hello,
      controller.signal,
      undefined,
      (...value) => reported.push(value),
    ),
    {code: 'CANCELLED'},
  );
  assert.deepEqual(reported, [[0, 3]]);
  assert.equal(source.calls.filter(([method]) => method === 'get').length, 1);
  assert.equal(session.backup, undefined);
});

for (const [type, addressType] of [
  ['secp256k1', 'bitcoin-segwit'],
  ['ed25519', 'solana'],
]) {
  for (const empty of [false, true]) {
    test(`Copy retains a ${empty ? 'cleared' : 'populated'} ${type} address record with its source key`, async () => {
      const wallets = empty
        ? []
        : [{addressType, seed: undefined, curve: undefined, path: undefined}];
      const {source, target, items, root, companion, records} = groupedFixture({
        type,
        wallets,
      });
      const snapshot = cardSnapshot(source, items);
      const fromCard = new CardBackupSession(snapshot, [hex(root.index)]);
      assert.deepEqual(
        fromCard.backup.items
          .filter(item => item.selected)
          .map(item => item.index),
        [hex(root.index), hex(companion.index)],
      );

      const session = new CardBackupSession();
      await session.readSource(source, source.hello, signal(), [
        hex(root.index),
      ]);
      const linked = session.backup.items.find(
        item => item.index === hex(companion.index),
      );
      assert.deepEqual(linked.derivationRecord.wallets, wallets);
      const payload = records.get(hex(companion.index));
      await session.addTarget(target.hello);
      await session.confirmTargets();
      await session.exportItems(source, source.hello, PIN, signal(), progress);
      await session.importItems(target, target.hello, PIN, signal(), progress);

      assert.deepEqual(
        [...target.records.keys()],
        [hex(root.index), hex(companion.index)],
      );
      assert.deepEqual(
        target.records.get(hex(companion.index)).metadata,
        root.index,
      );
      assert.deepEqual(records.get(hex(companion.index)), payload);
      assert.deepEqual(linked.derivationRecord.wallets, wallets);
      assert.equal(session.backup.complete, true);
    });
  }

  test(`Copy merges a cleared ${type} address record without deleting destination wallets`, async () => {
    const {source, target, root, companion} = groupedFixture({
      type,
      wallets: [],
    });
    const session = new CardBackupSession();
    await session.readSource(source, source.hello, signal(), [hex(root.index)]);
    await session.addTarget(target.hello);
    await session.confirmTargets();
    await session.exportItems(source, source.hello, PIN, signal(), progress);
    const existing = {
      index: companion.index,
      senderPublicKey: source.hello.publicKey,
      metadata: root.index,
      data: Uint8Array.from([
        target.hello.publicKey[1],
        ...encodeCardDerivationRecord({
          index: hex(root.index),
          wallets: [
            {addressType, seed: undefined, curve: undefined, path: undefined},
          ],
        }),
      ]),
    };
    target.records.set(hex(companion.index), structuredClone(existing));

    await session.importItems(target, target.hello, PIN, signal(), progress);

    const [copiedKey, conflictedRecord] = session.backup.targets[0].items;
    assert.equal(copiedKey.index, hex(root.index));
    assert.equal(copiedKey.imported, true);
    assert.equal(conflictedRecord.index, hex(companion.index));
    assert.equal(conflictedRecord.issue, undefined);
    assert.equal(conflictedRecord.imported, true);
    assert.deepEqual(
      session.backup.items.find(item => item.index === hex(companion.index))
        .derivationRecord.wallets,
      [],
    );
    assert.deepEqual(target.records.get(hex(companion.index)), existing);
    assert.equal(session.backup.complete, true);

    const callCount = target.calls.length;
    await session.importItems(target, target.hello, PIN, signal(), progress);
    assert.deepEqual(
      target.calls
        .slice(callCount)
        .filter(([method]) => method === 'importItem')
        .map(([, request]) => hex(request.index)),
      [],
    );
    assert.deepEqual(target.records.get(hex(companion.index)), existing);
    assert.equal(session.backup.complete, true);
  });
}

test('an orphan derivation record can be selected and copied on its own', async () => {
  const {source, target, orphan} = groupedFixture();
  const session = new CardBackupSession();
  await session.readSource(source, source.hello, signal(), [hex(orphan.index)]);
  assert.deepEqual(
    session.backup.items.filter(item => item.selected).map(item => item.index),
    [hex(orphan.index)],
  );
  await session.addTarget(target.hello);
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.deepEqual([...target.records.keys()], [hex(orphan.index)]);
  assert.equal(session.backup.complete, true);
});

test('invalid companion linkage retains opaque bytes while keeping other Copy items', async () => {
  const {source, root, companion, orphan, records} = groupedFixture();
  records.set(
    hex(companion.index),
    encodeCardDerivationRecord(orphan.derivationRecord),
  );
  const session = new CardBackupSession();
  await session.readSource(source, source.hello, signal());
  assert.deepEqual(
    session.backup.items.map(item => item.index),
    [hex(companion.index), hex(root.index), hex(orphan.index)],
  );
  assert.equal(session.busy, false);
  assert.deepEqual(
    source.calls.map(([method]) => method),
    ['list', 'get', 'get'],
  );
});

test('a companion import with a lost response reads that record and retains the acknowledged root', async () => {
  const {source, target, root, companion} = groupedFixture();
  const session = new CardBackupSession();
  await session.readSource(source, source.hello, signal(), [hex(root.index)]);
  await session.addTarget(target.hello);
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  target.afterImport = request => {
    if (hex(request.index) === hex(companion.index))
      throw new Error('Response lost');
  };
  await assert.rejects(
    session.importItems(target, target.hello, PIN, signal(), progress),
    /Response lost/,
  );
  assert.deepEqual(
    session.backup.targets[0].items.map(item => item.imported),
    [true, false],
  );
  assert.equal(session.backup.complete, false);
  assert.deepEqual(
    [...target.records.keys()],
    [hex(root.index), hex(companion.index)],
  );
  const sourceCalls = source.calls.length;
  target.afterImport = undefined;
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.equal(source.calls.length, sourceCalls);
  assert.deepEqual(
    target.calls
      .filter(([method]) => method === 'importItem')
      .map(([, request]) => hex(request.index)),
    [hex(root.index), hex(companion.index)],
  );
  assert.equal(session.backup.complete, true);
});

test('snapshot identity is checked with the full public key before the first source authentication', async () => {
  const {source, target, items} = fixture();
  const snapshot = cardSnapshot(source, items);
  const session = new CardBackupSession(snapshot);
  await session.addTarget(target.hello);
  await session.confirmTargets();
  const wrong = hello(3, {id: source.hello.id});
  await assert.rejects(
    session.exportItems(source, wrong, PIN, signal(), progress),
    /was reset or reinstalled/,
  );
  assert.deepEqual(source.calls, []);
});

test('invalid snapshot identity or missing selection rejects construction and leaves an existing copy unchanged on reset', async () => {
  const {source, target, items} = fixture();
  const snapshot = cardSnapshot(source, items);
  const session = new CardBackupSession(snapshot);
  await session.addTarget(target.hello);
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  const before = structuredClone(session.backup);
  for (const [invalid, selected] of [
    [{...snapshot, id: '01'}, undefined],
    [{...snapshot, publicKey: '04'}, undefined],
    [{...snapshot, publicKey: `05${snapshot.publicKey.slice(2)}`}, undefined],
    [snapshot, [hex(index(1)), hex(index(4))]],
  ]) {
    assert.throws(() => new CardBackupSession(invalid, selected));
    await assert.rejects(session.reset(invalid, selected));
    assert.deepEqual(session.backup, before);
    assert.equal(session.busy, false);
  }
});

test('resetting from the Card snapshot starts a new copy with the requested selection, and reset without a snapshot clears it', async () => {
  const {source, target, items} = fixture();
  const snapshot = cardSnapshot(source, items);
  const session = new CardBackupSession(snapshot);
  await session.addTarget(target.hello);
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.equal(session.backup.importStarted, true);
  const copied = structuredClone(target.records);
  const selected = [hex(index(2))];
  await session.reset(snapshot, selected);
  assert.equal(session.backup.importStarted, false);
  assert.equal(session.backup.complete, false);
  assert.equal(session.backup.targetsConfirmed, false);
  assert.deepEqual(session.backup.targets, []);
  assert.deepEqual(
    session.backup.items.filter(item => item.selected).map(item => item.index),
    selected,
  );
  assert.deepEqual(target.records, copied);
  await session.reset();
  assert.equal(session.backup, undefined);
  assert.deepEqual(target.records, copied);
});

test('backup preserves all item types and exact Export metadata within the page session', async () => {
  const {source, target, session, artifact} = await ready();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  await session.importItems(target, target.hello, PIN, signal(), progress);

  assert.equal(session.backup.complete, true);
  assert.equal(session.backup.items.length, 3);
  assert.equal(session.backup.items[1].type, undefined);
  assert.equal(session.backup.items[2].type, 0x1234);
  for (const request of target.records.values()) {
    const exported = artifact(request.index, target.hello.publicKey);
    assert.deepEqual(request, {
      index: request.index,
      senderPublicKey: source.hello.publicKey,
      ...exported,
    });
  }
  assert.equal(
    Object.hasOwn(session.backup.targets[0].items[0].exported, 'alias'),
    false,
  );
  assert.equal(
    Object.hasOwn(session.backup.targets[0].items[0].exported, 'metadata'),
    false,
  );
  assert.equal(session.backup.targets[0].items[1].exported.alias, '');
  assert.equal(session.backup.targets[0].items[1].exported.metadata, '');
  assert.equal(session.backup.targets[0].items[2].exported.alias, 'e\u0301');
  assert.equal(JSON.stringify(session.backup).includes(PIN), false);
  assert.deepEqual(
    source.calls.map(([method]) => method),
    [
      'list',
      'get',
      'authenticate',
      'exportItem',
      'get',
      'exportItem',
      'exportItem',
    ],
  );
});

test('a Card selection copies only the requested wallet key and non-key resource', async () => {
  const {source, target} = fixture();
  const session = new CardBackupSession();
  const selected = [hex(index(1)), hex(index(2))];
  await session.readSource(source, source.hello, signal(), selected);
  assert.deepEqual(
    session.backup.items.filter(item => item.selected).map(item => item.index),
    selected,
  );
  await session.addTarget(target.hello);
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.deepEqual(
    source.calls
      .filter(([method]) => method === 'exportItem')
      .map(([, request]) => hex(request.index)),
    selected,
  );
  assert.deepEqual([...target.records.keys()], selected);
  assert.equal(session.backup.complete, true);
});

test('an explicitly empty Card selection stays empty and cannot be confirmed', async () => {
  const {source, target} = fixture();
  const session = new CardBackupSession();
  await session.readSource(source, source.hello, signal(), []);
  assert.ok(session.backup.items.every(item => !item.selected));
  await session.addTarget(target.hello);
  await assert.rejects(session.confirmTargets(), /select|item/i);
  assert.equal(session.backup.targetsConfirmed, false);
  assert.deepEqual(
    source.calls.map(([method]) => method),
    ['list', 'get'],
  );
  await session.removeTarget(hex(target.hello.publicKey));
  await session.addTarget(target.hello);
  assert.ok(session.backup.items.every(item => !item.selected));
  await assert.rejects(session.confirmTargets(), /select|item/i);
});

test('a requested item missing from the card rejects the whole handoff without creating a copy and permits a new scan', async () => {
  const {source, target} = fixture();
  const session = new CardBackupSession();
  await assert.rejects(
    session.readSource(source, source.hello, signal(), [
      hex(index(1)),
      hex(index(4)),
    ]),
    /missing|not found|no longer/i,
  );
  assert.equal(session.backup, undefined);
  assert.equal(session.busy, false);
  assert.deepEqual(
    source.calls.map(([method]) => method),
    ['list', 'get'],
  );
  await session.readSource(source, source.hello, signal(), [hex(index(1))]);
  await session.addTarget(target.hello);
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.deepEqual([...target.records.keys()], [hex(index(1))]);
  assert.equal(session.backup.complete, true);
});

test('same display ID with another public key is rejected before any authentication or import', async () => {
  const {session, source, target} = await ready();
  const wrongSource = hello(3, {id: source.hello.id});
  assert.throws(
    () => assertBackupCard(wrongSource, session.backup.source),
    /was reset or reinstalled/,
  );
  await assert.rejects(
    session.exportItems(source, wrongSource, PIN, signal(), progress),
    /was reset or reinstalled/,
  );
  assert.equal(source.calls.length, 2);

  await session.exportItems(source, source.hello, PIN, signal(), progress);
  const wrongTarget = hello(3, {id: target.hello.id});
  await assert.rejects(
    session.importItems(target, wrongTarget, PIN, signal(), progress),
    /Wrong card/,
  );
  assert.equal(target.calls.length, 0);
});

test('identity validation rejects invalid, uninitialized, and blocked source or destination cards', async () => {
  assert.throws(
    () => getBackupCardIdentity(hello(1, {publicKey: new Uint8Array(65)})),
    /valid identity/,
  );
  assert.throws(
    () => getBackupCardIdentity(hello(1, {secretPIN: false})),
    /Initialize/,
  );
  assert.throws(
    () => getBackupCardIdentity(hello(1, {accessPIN: false})),
    /Initialize/,
  );
  assert.throws(
    () => getBackupCardIdentity(hello(1, {accessPIN: 0})),
    /blocked/i,
  );
  assert.throws(
    () => getBackupCardIdentity(hello(1, {secretPIN: 0})),
    /blocked/i,
  );
  const {session, source, target} = await ready();
  await assert.rejects(
    session.exportItems(
      source,
      hello(1, {secretPIN: 0}),
      PIN,
      signal(),
      progress,
    ),
    /blocked/,
  );
  assert.equal(source.calls.length, 2);
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  await assert.rejects(
    session.importItems(
      target,
      hello(2, {secretPIN: 0}),
      PIN,
      signal(),
      progress,
    ),
    /blocked/i,
  );
  await assert.rejects(
    session.importItems(
      target,
      hello(2, {accessPIN: 0}),
      PIN,
      signal(),
      progress,
    ),
    /blocked/i,
  );
  assert.equal(target.calls.length, 0);
  assert.equal(session.backup.complete, false);
});

function uninitializedTarget({hasSecretPIN = false} = {}) {
  const first = hello(2, {
    secretPIN: hasSecretPIN ? 5 : false,
    accessPIN: false,
  });
  const state = {
    first,
    fresh: structuredClone(first),
    result: hello(2),
    calls: [],
    applet: {
      async authenticate(request) {
        state.calls.push(['authenticate', request]);
        await state.onAuthenticate?.();
      },
      async setPIN(request) {
        state.calls.push(['setPIN', request]);
        await state.onSetPIN?.();
      },
      async hello(request) {
        state.calls.push(['hello', request]);
        await state.onHello?.();
        return state.result;
      },
    },
  };
  return state;
}

test('a new destination sets only the Secret PIN and verifies initialized Access PIN state with Hello', async () => {
  const state = uninitializedTarget();
  const result = await initializeBackupTarget(
    state.applet,
    state.fresh,
    state.first,
    PIN,
    signal(),
    undefined,
    PIN,
  );

  assert.deepEqual(state.calls, [
    ['setPIN', {secret: true, pin: PIN}],
    ['hello', {}],
  ]);
  assert.equal(result.pins.access, 5);
  assert.equal(result.pins.secret, 5);
  assert.deepEqual(result.publicKey, state.first.publicKey);
  assert.deepEqual(
    getBackupCardIdentity(result),
    getBackupCardIdentity(state.result),
  );
});

test('initializing a missing Access PIN authenticates with the existing Secret PIN without changing it', async () => {
  const state = uninitializedTarget({hasSecretPIN: true});
  const result = await initializeBackupTarget(
    state.applet,
    state.fresh,
    state.first,
    PIN,
    signal(),
    undefined,
    PIN,
  );

  assert.deepEqual(state.calls, [
    ['authenticate', {secret: true, pin: PIN}],
    ['setPIN', {pin: PIN}],
    ['hello', {}],
  ]);
  assert.equal(result.pins.access, 5);
  assert.equal(result.pins.secret, 5);
});

test('new setup writes a distinct Access PIN only after Secret PIN authentication', async () => {
  const state = uninitializedTarget();
  await initializeMonoidCard(
    state.applet,
    state.fresh,
    PIN,
    signal(),
    'Access-42',
  );
  assert.deepEqual(state.calls, [
    ['setPIN', {secret: true, pin: PIN}],
    ['authenticate', {secret: true, pin: PIN}],
    ['setPIN', {pin: 'Access-42'}],
    ['hello', {}],
  ]);
});

test('restoration writes the selected Access PIN without changing existing Secret PIN', async () => {
  const state = uninitializedTarget({hasSecretPIN: true});
  await initializeMonoidCard(
    state.applet,
    state.fresh,
    PIN,
    signal(),
    'Saved-42',
  );
  assert.deepEqual(state.calls, [
    ['authenticate', {secret: true, pin: PIN}],
    ['setPIN', {pin: 'Saved-42'}],
    ['hello', {}],
  ]);
});

test('missing Access PIN choice stops initialization before mutation', async () => {
  const state = uninitializedTarget();
  await assert.rejects(
    initializeMonoidCard(state.applet, state.fresh, PIN, signal()),
    /Access PIN/,
  );
  assert.deepEqual(state.calls, []);
});

test('initialization rejects a different full public key before authentication or mutation even with the same display ID', async () => {
  const state = uninitializedTarget({hasSecretPIN: true});
  const wrong = hello(3, {id: state.first.id});
  await assert.rejects(
    initializeBackupTarget(
      state.applet,
      wrong,
      state.first,
      PIN,
      signal(),
      PIN,
    ),
    /was reset or reinstalled/,
  );
  assert.deepEqual(state.calls, []);
});

test('a Secret PIN configured after the first scan is never overwritten by the initialization flow', async () => {
  const state = uninitializedTarget();
  state.fresh.pins.secret = 5;
  await assert.rejects(
    initializeBackupTarget(
      state.applet,
      state.fresh,
      state.first,
      PIN,
      signal(),
      undefined,
      PIN,
    ),
    /changed|already|again/i,
  );
  assert.deepEqual(state.calls, []);
});

test('an already restored destination returns its fresh ready state without changing its PIN again', async () => {
  const state = uninitializedTarget({hasSecretPIN: true});
  const result = await initializeBackupTarget(
    state.applet,
    state.result,
    state.first,
    PIN,
    signal(),
    undefined,
    PIN,
  );
  assert.deepEqual(result, state.result);
  assert.deepEqual(state.calls, []);
});

for (const stopAfter of ['before-start', 'authenticate', 'setPIN', 'hello']) {
  test(`initialization cancellation after ${stopAfter} starts no later card command`, async () => {
    const state = uninitializedTarget({hasSecretPIN: true});
    const controller = new AbortController();
    if (stopAfter === 'before-start') controller.abort();
    else if (stopAfter === 'authenticate')
      state.onAuthenticate = () => controller.abort();
    else if (stopAfter === 'setPIN') state.onSetPIN = () => controller.abort();
    else state.onHello = () => controller.abort();

    await assert.rejects(
      initializeBackupTarget(
        state.applet,
        state.fresh,
        state.first,
        PIN,
        controller.signal,
        undefined,
        PIN,
      ),
      {code: 'CANCELLED'},
    );
    assert.deepEqual(
      state.calls.map(([method]) => method),
      stopAfter === 'before-start'
        ? []
        : stopAfter === 'authenticate'
          ? ['authenticate']
          : stopAfter === 'setPIN'
            ? ['authenticate', 'setPIN']
            : ['authenticate', 'setPIN', 'hello'],
    );
  });
}

test('incorrect existing Secret PIN is attempted once and never followed by a write', async () => {
  const state = uninitializedTarget({hasSecretPIN: true});
  state.onAuthenticate = () => {
    throw new CBORAppletError({code: 'INVALID_PIN', tries: 4});
  };
  await assert.rejects(
    initializeBackupTarget(
      state.applet,
      state.fresh,
      state.first,
      PIN,
      signal(),
      undefined,
      PIN,
    ),
    /4 tries left/i,
  );
  assert.deepEqual(
    state.calls.map(([method]) => method),
    ['authenticate'],
  );
});

for (const invalidResult of [
  'access-unset',
  'access-blocked',
  'safe-unset',
  'safe-blocked',
  'identity-changed',
  'monoid-id-changed',
]) {
  test(`initialization cannot succeed when final Hello reports ${invalidResult}`, async () => {
    const state = uninitializedTarget();
    if (invalidResult === 'access-unset') state.result.pins.access = false;
    else if (invalidResult === 'access-blocked') state.result.pins.access = 0;
    else if (invalidResult === 'safe-unset') state.result.pins.secret = false;
    else if (invalidResult === 'safe-blocked') state.result.pins.secret = 0;
    else if (invalidResult === 'monoid-id-changed')
      state.result.id = hello(3).id;
    else state.result.publicKey = hello(3).publicKey;

    await assert.rejects(
      initializeBackupTarget(
        state.applet,
        state.fresh,
        state.first,
        PIN,
        signal(),
        undefined,
        PIN,
      ),
      invalidResult === 'identity-changed'
        ? /was reset or reinstalled/
        : /incomplete|blocked|Wrong card/i,
    );
    assert.deepEqual(
      state.calls.map(([method]) => method),
      ['setPIN', 'hello'],
    );
  });
}

test('shared initialization preserves an invalid Secret PIN error for interactive retry', async () => {
  const state = uninitializedTarget({hasSecretPIN: true});
  const invalidPIN = new CBORAppletError({code: 'INVALID_PIN', tries: 4});
  state.onAuthenticate = () => {
    throw invalidPIN;
  };

  await assert.rejects(
    initializeMonoidCard(state.applet, state.fresh, PIN, signal(), PIN),
    error => error === invalidPIN,
  );
  assert.deepEqual(state.calls, [['authenticate', {secret: true, pin: PIN}]]);
});

for (const invalidState of ['access-blocked', 'safe-blocked', 'safe-unset']) {
  test(`shared initialization starts no commands when ${invalidState}`, async () => {
    const state = uninitializedTarget({hasSecretPIN: true});
    if (invalidState === 'access-blocked') state.fresh.pins.access = 0;
    else if (invalidState === 'safe-blocked') state.fresh.pins.secret = 0;
    else {
      state.fresh.pins.access = 5;
      state.fresh.pins.secret = false;
    }

    await assert.rejects(
      initializeMonoidCard(state.applet, state.fresh, PIN, signal(), PIN),
      /blocked|needs attention/,
    );
    assert.deepEqual(state.calls, []);
  });
}

test('shared initialization rejects invalid PIN formats before writing a new Safe', async () => {
  const state = uninitializedTarget();
  await assert.rejects(
    initializeMonoidCard(state.applet, state.fresh, 'short', signal()),
    /6 to 16 characters/,
  );
  assert.deepEqual(state.calls, []);
});

test('shared initialization returns a card with both PINs set without any commands', async () => {
  const state = uninitializedTarget({hasSecretPIN: true});
  state.fresh.pins.access = 5;
  const result = await initializeMonoidCard(
    state.applet,
    state.fresh,
    PIN,
    signal(),
    PIN,
  );

  assert.deepEqual(state.calls, []);
  assert.equal(result, state.fresh);
});

test('wrong Secret PIN is attempted once and never exports or retains the PIN', async () => {
  const {session, source} = await ready();
  await assert.rejects(
    session.exportItems(source, source.hello, 'Wrong-PIN', signal(), progress),
    /4 tries left/,
  );
  assert.deepEqual(
    source.calls.map(([method]) => method),
    ['list', 'get', 'authenticate'],
  );
  assert.equal(session.busy, false);
  assert.equal(JSON.stringify(session.backup).includes('Wrong-PIN'), false);
});

test('destination import verifies Secret PIN before writing and does not retain a failed PIN', async () => {
  const {session, source, target} = await ready();
  await session.exportItems(source, source.hello, PIN, signal(), progress);

  await assert.rejects(
    session.importItems(target, target.hello, 'Wrong-PIN', signal(), progress),
    /Incorrect Secret PIN, 4 tries left/,
  );

  assert.deepEqual(target.authentications, [{secret: true, pin: 'Wrong-PIN'}]);
  assert.deepEqual(target.calls, []);
  assert.equal(session.backup.importStarted, false);
  assert.equal(JSON.stringify(session.backup).includes('Wrong-PIN'), false);
});

test('an import resumed after SELECT authenticates the destination again before sending more items', async () => {
  const {session, source, target} = await ready();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  let authenticated = false;
  target.authenticate = async request => {
    assert.deepEqual(request, {secret: true, pin: PIN});
    target.authentications.push(request);
    authenticated = true;
  };
  target.beforeImport = request => {
    assert.equal(authenticated, true);
    if (hex(request.index) === hex(index(2))) throw new Error('Tag lost');
  };

  await assert.rejects(
    session.importItems(target, target.hello, PIN, signal(), progress),
    /Tag lost/,
  );
  authenticated = false;
  target.beforeImport = () => assert.equal(authenticated, true);
  await session.importItems(target, target.hello, PIN, signal(), progress);

  assert.equal(target.authentications.length, 2);
  assert.equal(session.backup.complete, true);
  assert.equal(JSON.stringify(session.backup).includes(PIN), false);
});

test('an interrupted export retries only remaining items within the same session', async () => {
  const {session, source} = await ready();
  source.onExport = request => {
    if (hex(request.index) === hex(index(2))) throw new Error('Tag lost');
  };
  await assert.rejects(
    session.exportItems(source, source.hello, PIN, signal(), progress),
    /Tag lost/,
  );
  assert.ok(session.backup.targets[0].items[0].exported);
  assert.equal(session.backup.targets[0].items[1].exported, undefined);
  source.onExport = undefined;
  const start = source.calls.length;
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  assert.deepEqual(
    source.calls
      .slice(start)
      .map(([method, request]) => [
        method,
        request.index && hex(request.index),
      ]),
    [
      ['authenticate', undefined],
      ['get', hex(index(2))],
      ['exportItem', hex(index(2))],
      ['exportItem', hex(index(3))],
    ],
  );
});

test('lost Import acknowledgement reconciles stored fields without re-export or another Import', async () => {
  const {session, source, target} = await ready();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  target.afterImport = request => {
    if (hex(request.index) === hex(index(2))) throw new Error('Response lost');
  };
  await assert.rejects(
    session.importItems(target, target.hello, PIN, signal(), progress),
    /Response lost/,
  );
  assert.equal(session.backup.targets[0].items[0].imported, true);
  assert.equal(session.backup.targets[0].items[1].imported, false);
  assert.equal(session.series.completedCount, 0);
  assert.equal(session.series.hasFinished(hex(target.hello.publicKey)), false);
  const firstAttempt = target.calls.find(
    ([method, request]) =>
      method === 'importItem' && hex(request.index) === hex(index(2)),
  )[1];
  target.afterImport = undefined;
  const start = target.calls.length;
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.deepEqual(target.calls[start], ['view', {index: firstAttempt.index}]);
  assert.equal(
    target.calls
      .slice(start)
      .some(
        ([method, request]) =>
          method === 'importItem' &&
          hex(request.index) === hex(firstAttempt.index),
      ),
    false,
  );
  assert.equal(target.records.size, 3);
  assert.equal(session.backup.complete, true);
  assert.equal(session.series.completedCount, 1);
  assert.throws(
    () => session.series.assertPending(hex(target.hello.publicKey)),
    /Card already done/,
  );
});

test('conflicts preserve target data and allow independent remaining items to finish', async () => {
  const {session, source, target} = await ready();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  const conflicting = {index: index(2), data: bytes('deadbeef')};
  target.records.set(hex(index(2)), conflicting);
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.equal(session.backup.complete, true);
  assert.equal(session.backup.targets[0].items[1].issue?.reason, 'Conflict');
  assert.deepEqual(
    session.backup.targets[0].items.map(item => item.imported),
    [true, false, true],
  );
  assert.deepEqual(target.records.get(hex(index(2))), conflicting);
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.equal(session.backup.targets[0].items[1].issue?.reason, 'Conflict');
  assert.deepEqual(target.records.get(hex(index(2))), conflicting);
});

test('cancellation after acknowledged Import retains that item and starts no next APDU', async () => {
  const {session, source, target} = await ready();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  const controller = new AbortController();
  const reported = [];
  target.afterImport = () => controller.abort();
  await assert.rejects(
    session.importItems(
      target,
      target.hello,
      PIN,
      controller.signal,
      (...value) => reported.push(value),
    ),
    {code: 'CANCELLED'},
  );
  assert.equal(target.calls.length, 2);
  assert.deepEqual(
    session.backup.targets[0].items.map(item => item.imported),
    [true, false, false],
  );
  assert.deepEqual(reported, [[0, 3]]);
});

test('cancellation after acknowledged Export retains its artifact without publishing late progress', async () => {
  const {session, source} = await ready();
  const controller = new AbortController();
  const reported = [];
  source.onExport = () => controller.abort();

  await assert.rejects(
    session.exportItems(
      source,
      source.hello,
      PIN,
      controller.signal,
      (...value) => reported.push(value),
    ),
    {code: 'CANCELLED'},
  );

  assert.equal(
    source.calls.filter(([method]) => method === 'exportItem').length,
    1,
  );
  assert.equal(
    session.backup.targets[0].items.filter(item => item.exported).length,
    1,
  );
  assert.deepEqual(reported, [[0, 3]]);
});

test('a cancelled source authentication does not publish export progress or begin exports', async () => {
  const {session, source} = await ready();
  const controller = new AbortController();
  source.authenticate = async () => controller.abort();

  await assert.rejects(
    session.exportItems(source, source.hello, PIN, controller.signal, () =>
      assert.fail('Late progress'),
    ),
    {code: 'CANCELLED'},
  );
  assert.equal(
    source.calls.filter(([method]) => method === 'exportItem').length,
    0,
  );
});

test('Import counts only acknowledged items without rereading the destination', async () => {
  const {session, source, target} = await ready();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  target.records.set(hex(index(2)), {index: index(2), data: bytes('deadbeef')});
  const reported = [];
  target.list = () => assert.fail('Acknowledged imports need no final List');

  await session.importItems(target, target.hello, PIN, signal(), (...value) =>
    reported.push(value),
  );

  assert.deepEqual(reported, [
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
  ]);
  assert.equal(session.backup.targets[0].complete, true);
});

test('cancellation with the final Import ACK preserves completion without a later command', async () => {
  const {session, source, target} = await ready();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  const controller = new AbortController();
  const reported = [];
  target.afterImport = request => {
    if (hex(request.index) === hex(index(3))) controller.abort();
  };
  target.list = () => assert.fail('Acknowledged imports need no final List');

  await assert.rejects(
    session.importItems(
      target,
      target.hello,
      PIN,
      controller.signal,
      (...value) => reported.push(value),
    ),
    {code: 'CANCELLED'},
  );
  assert.deepEqual(reported, [
    [0, 3],
    [1, 3],
    [2, 3],
  ]);
  assert.equal(
    session.backup.targets[0].items.every(item => item.imported),
    true,
  );
  assert.equal(session.backup.targets[0].complete, true);
  assert.equal(
    target.calls.filter(([method]) => method === 'importItem').length,
    3,
  );
  assert.equal(target.calls.filter(([method]) => method === 'list').length, 0);
  assert.equal(session.backup.complete, true);
});

for (const lostAck of [false, true]) {
  test(`a new Copy page confirms EXISTS after ${lostAck ? 'an uncertain Import' : 'completed imports'}`, async () => {
    const {session, source, target} = await ready();
    await session.exportItems(source, source.hello, PIN, signal(), progress);
    if (lostAck) {
      target.afterImport = request => {
        if (hex(request.index) === hex(index(3)))
          throw new Error('Lost acknowledgement');
      };
      await assert.rejects(
        session.importItems(target, target.hello, PIN, signal(), progress),
        /Lost acknowledgement/,
      );
      assert.equal(session.backup.complete, false);
      assert.equal(
        target.calls.filter(([method]) => method === 'importItem').length,
        3,
        'no automatic replay',
      );
      target.afterImport = undefined;
    } else {
      await session.importItems(target, target.hello, PIN, signal(), progress);
    }
    const existing = structuredClone(target.records);

    const next = new CardBackupSession();
    assert.equal(next.backup, undefined);
    assert.equal(next.busy, false);
    await session.reset();
    assert.equal(session.backup, undefined);
    assert.deepEqual(target.records, existing);

    await next.readSource(source, source.hello, signal());
    assert.equal(next.backup.targets.length, 0);
    assert.equal(next.backup.targetsConfirmed, false);
    await next.addTarget(target.hello);
    await next.confirmTargets();
    await next.exportItems(source, source.hello, PIN, signal(), progress);
    await next.importItems(target, target.hello, PIN, signal(), progress);

    assert.equal(next.backup.complete, true);
    assert.deepEqual(target.records, existing);
    assert.equal(
      target.calls.filter(([method]) => method === 'importItem').length,
      3,
    );
  });
}

test('no state mutation is allowed while an operation is waiting for the card', async () => {
  const {session, source, target, secondTarget, items} = await ready();
  let release;
  let entered;
  const started = new Promise(resolve => {
    entered = resolve;
  });
  const gate = new Promise(resolve => {
    release = resolve;
  });
  source.onExport = async () => {
    entered();
    await gate;
  };
  const exporting = session.exportItems(
    source,
    source.hello,
    PIN,
    signal(),
    progress,
  );
  await started;
  try {
    assert.equal(session.busy, true);
    await assert.rejects(session.reset(), /already in progress/);
    await assert.rejects(
      session.reset(cardSnapshot(source, items), []),
      /already in progress/,
    );
    await assert.rejects(
      session.addTarget(secondTarget.hello),
      /already in progress/,
    );
    await assert.rejects(
      session.removeTarget(hex(target.hello.publicKey)),
      /already in progress/,
    );
  } finally {
    release();
    await exporting;
  }
  assert.equal(session.busy, false);
  await session.reset();
  assert.equal(session.backup, undefined);
});

test('the initial selection remains fixed through destination changes and the source cannot be its own target', async () => {
  const {source, target, secondTarget} = fixture();
  const session = new CardBackupSession();
  const selected = [hex(index(1)), hex(index(3))];
  await session.readSource(source, source.hello, signal(), selected);
  await assert.rejects(session.addTarget(source.hello), /different card/);
  await session.addTarget(target.hello);
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  await session.addTarget(secondTarget.hello);
  await session.removeTarget(hex(secondTarget.hello.publicKey));
  assert.equal(session.backup.targetsConfirmed, false);
  assert.equal(session.backup.targets[0].items.length, 0);
  assert.deepEqual(
    session.backup.items.filter(item => item.selected).map(item => item.index),
    selected,
  );
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.equal(session.backup.complete, true);
  assert.equal(target.records.size, 2);
  assert.equal(target.records.has(hex(index(2))), false);
  assert.equal(target.records.has(hex(index(3))), true);
});

test('multiple destinations receive their own ciphertext and can finish in either order', async () => {
  const {session, source, target, secondTarget, artifact} = await ready({
    multiple: true,
  });
  const exportedProgress = [];
  await session.exportItems(
    source,
    source.hello,
    PIN,
    signal(),
    (current, total) => {
      exportedProgress.push([current, total]);
    },
  );
  assert.equal(
    source.calls.filter(([method]) => method === 'authenticate').length,
    1,
  );
  const exports = source.calls.filter(([method]) => method === 'exportItem');
  assert.equal(exports.length, 6);
  for (const card of [target, secondTarget]) {
    assert.deepEqual(
      exports
        .filter(
          ([, request]) =>
            hex(request.recipientPublicKey) === hex(card.hello.publicKey),
        )
        .map(([, request]) => hex(request.index))
        .sort(),
      [1, 2, 3].map(value => hex(index(value))),
    );
  }
  assert.deepEqual(
    exportedProgress,
    Array.from({length: 7}, (_, current) => [current, 6]),
  );
  assert.notEqual(
    session.backup.targets[0].items[0].exported.data,
    session.backup.targets[1].items[0].exported.data,
  );

  const importedProgress = [];
  await session.importItems(
    secondTarget,
    secondTarget.hello,
    PIN,
    signal(),
    (current, total) => {
      importedProgress.push([current, total]);
    },
  );
  assert.deepEqual(importedProgress.at(-1), [3, 3]);
  assert.equal(target.calls.length, 0);
  assert.deepEqual(
    session.backup.targets.map(card => card.complete),
    [false, true],
  );
  assert.equal(session.backup.complete, false);
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.deepEqual(
    session.backup.targets.map(card => card.complete),
    [true, true],
  );
  assert.equal(session.backup.complete, true);
  for (const card of [target, secondTarget]) {
    for (const request of card.records.values()) {
      assert.deepEqual(request, {
        index: request.index,
        senderPublicKey: source.hello.publicKey,
        ...artifact(request.index, card.hello.publicKey),
      });
    }
  }
});

test('same-bundle destinations reuse one export per item and import in either order', async () => {
  const {session, source, target, secondTarget} = await ready({
    multiple: true,
    bundle: true,
  });
  const reported = [];
  await session.exportItems(source, source.hello, PIN, signal(), (...value) =>
    reported.push(value),
  );
  const exports = source.calls.filter(([method]) => method === 'exportItem');
  assert.deepEqual(
    exports.map(([, request]) => hex(request.index)),
    [1, 2, 3].map(value => hex(index(value))),
  );
  assert.ok(exports.every(([, request]) => !('recipientPublicKey' in request)));
  assert.deepEqual(
    session.backup.targets[0].items.map(item => item.exported),
    session.backup.targets[1].items.map(item => item.exported),
  );
  assert.deepEqual(
    reported,
    Array.from({length: 7}, (_, count) => [count, 6]),
  );

  await session.importItems(
    secondTarget,
    secondTarget.hello,
    PIN,
    signal(),
    progress,
  );
  assert.deepEqual(
    session.backup.targets.map(card => card.complete),
    [false, true],
  );
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.equal(session.backup.complete, true);
  for (const card of [target, secondTarget]) {
    assert.ok(
      card.calls.every(
        ([method]) => method === 'importItem' || method === 'view',
      ),
    );
    assert.ok(
      card.calls.every(([, request]) => !('senderPublicKey' in request)),
    );
  }
});

test('a retained bundle export is reused across destinations after cancellation', async () => {
  const {session, source} = await ready({multiple: true, bundle: true});
  const controller = new AbortController();
  source.onExport = () => controller.abort();
  await assert.rejects(
    session.exportItems(source, source.hello, PIN, controller.signal, progress),
    {code: 'CANCELLED'},
  );
  const retained = session.backup.targets[0].items[0].exported;
  assert.ok(retained);
  assert.equal(session.backup.targets[1].items[0].exported, undefined);

  source.onExport = undefined;
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  assert.deepEqual(
    source.calls
      .filter(([method]) => method === 'exportItem')
      .map(([, request]) => hex(request.index)),
    [1, 2, 3].map(value => hex(index(value))),
  );
  assert.ok(
    session.backup.targets.every(card =>
      card.items.every(item => item.exported),
    ),
  );
  assert.deepEqual(session.backup.targets[1].items[0].exported, retained);
});

test('destination duplicates use the complete public key, while equal display IDs remain distinct', async () => {
  const {source, target, secondTarget} = fixture();
  const session = new CardBackupSession();
  await session.readSource(source, source.hello, signal());
  await session.addTarget(target.hello);
  await assert.rejects(
    session.addTarget(hello(2, {id: bytes('ffffffff')})),
    /already|duplicate/i,
  );
  secondTarget.hello.id = target.hello.id;
  await session.addTarget(secondTarget.hello);
  assert.equal(session.backup.targets.length, 2);
  assert.equal(session.backup.targets[0].id, session.backup.targets[1].id);
  assert.notEqual(
    session.backup.targets[0].publicKey,
    session.backup.targets[1].publicKey,
  );
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  await session.importItems(
    secondTarget,
    secondTarget.hello,
    PIN,
    signal(),
    progress,
  );
  assert.deepEqual(
    session.backup.targets.map(card => card.complete),
    [false, true],
  );
});

test('export requires explicit destination confirmation before authenticating the source', async () => {
  const {source, target} = fixture();
  const session = new CardBackupSession();
  await session.readSource(source, source.hello, signal());
  await session.addTarget(target.hello);
  await assert.rejects(
    session.exportItems(source, source.hello, PIN, signal(), progress),
    /confirm/i,
  );
  assert.deepEqual(
    source.calls.map(([method]) => method),
    ['list', 'get'],
  );
  assert.equal(session.backup.targetsConfirmed, false);
});

test('removing a destination before confirmation excludes it from export and import', async () => {
  const {source, target, secondTarget} = fixture();
  const session = new CardBackupSession();
  await session.readSource(source, source.hello, signal());
  await session.addTarget(target.hello);
  await session.addTarget(secondTarget.hello);
  await session.removeTarget(hex(target.hello.publicKey));
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  const exports = source.calls.filter(([method]) => method === 'exportItem');
  assert.equal(exports.length, 3);
  assert.ok(
    exports.every(
      ([, request]) =>
        hex(request.recipientPublicKey) === hex(secondTarget.hello.publicKey),
    ),
  );
  await assert.rejects(
    session.importItems(target, target.hello, PIN, signal(), progress),
    /Wrong card|destination|added/i,
  );
  assert.equal(target.calls.length, 0);
  await session.importItems(
    secondTarget,
    secondTarget.hello,
    PIN,
    signal(),
    progress,
  );
  assert.equal(session.backup.complete, true);
});

test('an interrupted export for a later destination preserves earlier destination artifacts', async () => {
  const {session, source, target, secondTarget} = await ready({multiple: true});
  source.onExport = request => {
    if (
      hex(request.recipientPublicKey) === hex(secondTarget.hello.publicKey) &&
      hex(request.index) === hex(index(2))
    ) {
      throw new Error('Tag lost');
    }
  };
  await assert.rejects(
    session.exportItems(source, source.hello, PIN, signal(), progress),
    /Tag lost/,
  );
  assert.ok(session.backup.targets[0].items.every(item => item.exported));
  assert.deepEqual(
    session.backup.targets[1].items.map(item => Boolean(item.exported)),
    [true, false, false],
  );
  const previous = session.backup.targets[0].items.map(
    item => item.exported.data,
  );
  source.onExport = undefined;
  const start = source.calls.length;
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  const retriedExports = source.calls
    .slice(start)
    .filter(([method]) => method === 'exportItem');
  assert.equal(retriedExports.length, 2);
  assert.ok(
    retriedExports.every(
      ([, request]) =>
        hex(request.recipientPublicKey) === hex(secondTarget.hello.publicKey),
    ),
  );
  assert.deepEqual(
    session.backup.targets[0].items.map(item => item.exported.data),
    previous,
  );
  await session.importItems(target, target.hello, PIN, signal(), progress);
  await session.importItems(
    secondTarget,
    secondTarget.hello,
    PIN,
    signal(),
    progress,
  );
  assert.equal(session.backup.complete, true);
});

test('conflicts and interrupted imports remain isolated to their destination', async () => {
  const {session, source, target, secondTarget} = await ready({multiple: true});
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  const conflicting = {index: index(2), data: bytes('deadbeef')};
  target.records.set(hex(index(2)), conflicting);
  await session.importItems(target, target.hello, PIN, signal(), progress);
  secondTarget.afterImport = request => {
    if (hex(request.index) === hex(index(2))) throw new Error('Response lost');
  };
  await assert.rejects(
    session.importItems(
      secondTarget,
      secondTarget.hello,
      PIN,
      signal(),
      progress,
    ),
    /Response lost/,
  );
  assert.deepEqual(
    session.backup.targets[0].items.map(item => item.imported),
    [true, false, true],
  );
  assert.equal(session.backup.targets[0].items[1].issue?.reason, 'Conflict');
  assert.deepEqual(
    session.backup.targets[1].items.map(item => item.imported),
    [true, false, false],
  );
  assert.ok(session.backup.targets[1].items.every(item => !item.issue));
  const firstCardCalls = target.calls.length;
  secondTarget.afterImport = undefined;
  await session.importItems(
    secondTarget,
    secondTarget.hello,
    PIN,
    signal(),
    progress,
  );
  assert.equal(target.calls.length, firstCardCalls);
  assert.deepEqual(target.records.get(hex(index(2))), conflicting);
  assert.deepEqual(
    session.backup.targets.map(card => card.complete),
    [true, true],
  );
  assert.equal(session.backup.complete, true);
});

function assertExportsCleared(session) {
  assert.equal(session.backup.targetsConfirmed, false);
  assert.equal(session.backup.complete, false);
  assert.equal(session.backup.importStarted, false);
  assert.ok(session.backup.targets.every(target => !target.complete));
  assert.ok(session.backup.targets.every(target => target.items.length === 0));
}

test('adding a destination after a partial export clears previous artifacts before exporting for all cards', async () => {
  const {session, source, target, secondTarget} = await ready();
  source.onExport = request => {
    if (hex(request.index) === hex(index(2))) throw new Error('Tag lost');
  };
  await assert.rejects(
    session.exportItems(source, source.hello, PIN, signal(), progress),
    /Tag lost/,
  );
  assert.ok(session.backup.targets[0].items[0].exported);
  await session.addTarget(secondTarget.hello);
  assertExportsCleared(session);
  assert.equal(session.backup.targets.length, 2);
  source.onExport = undefined;
  const start = source.calls.length;
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  const exports = source.calls
    .slice(start)
    .filter(([method]) => method === 'exportItem');
  assert.equal(exports.length, 6);
  for (const card of [target, secondTarget]) {
    assert.deepEqual(
      exports
        .filter(
          ([, request]) =>
            hex(request.recipientPublicKey) === hex(card.hello.publicKey),
        )
        .map(([, request]) => hex(request.index))
        .sort(),
      [1, 2, 3].map(value => hex(index(value))),
    );
    await session.importItems(card, card.hello, PIN, signal(), progress);
  }
  assert.equal(session.backup.complete, true);
});

test('removing a destination after export clears artifacts and reexports only to the remaining card', async () => {
  const {session, source, target, secondTarget} = await ready({multiple: true});
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  await session.removeTarget(hex(target.hello.publicKey));
  assertExportsCleared(session);
  assert.equal(session.backup.targets.length, 1);
  const start = source.calls.length;
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  const exports = source.calls
    .slice(start)
    .filter(([method]) => method === 'exportItem');
  assert.equal(exports.length, 3);
  assert.ok(
    exports.every(
      ([, request]) =>
        hex(request.recipientPublicKey) === hex(secondTarget.hello.publicKey),
    ),
  );
  await assert.rejects(
    session.importItems(target, target.hello, PIN, signal(), progress),
    /Wrong card|destination|added/i,
  );
  assert.equal(target.calls.length, 0);
  await session.importItems(
    secondTarget,
    secondTarget.hello,
    PIN,
    signal(),
    progress,
  );
  assert.equal(session.backup.complete, true);
});

test('invalid destination edits preserve confirmed artifacts', async () => {
  const {session, source, target} = await ready();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  const before = structuredClone(session.backup);
  for (const operation of [
    () => session.addTarget(target.hello),
    () => session.addTarget(source.hello),
    () => session.removeTarget(hex(hello(4).publicKey)),
  ]) {
    await assert.rejects(operation());
    assert.deepEqual(session.backup, before);
  }
  const sourceCalls = source.calls.length;
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.equal(source.calls.length, sourceCalls);
  assert.equal(session.backup.complete, true);
});

test('wrong-card and cancelled import preflight leave destinations editable', async () => {
  const {session, source, target, secondTarget} = await ready();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  assert.equal(session.backup.importStarted, false);
  await assert.rejects(
    session.importItems(target, hello(3), PIN, signal(), progress),
    /Wrong card|destination|added/i,
  );
  assert.equal(session.backup.importStarted, false);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    session.importItems(target, target.hello, PIN, controller.signal, progress),
    {code: 'CANCELLED'},
  );
  assert.equal(target.calls.length, 0);
  assert.equal(session.backup.importStarted, false);
  await session.addTarget(secondTarget.hello);
  await session.removeTarget(hex(target.hello.publicKey));
  assertExportsCleared(session);
});

for (const failure of ['before-acknowledgement', 'after-card-commit']) {
  test(`the first actual import locks destination edits despite ${failure} failure and retries the original artifact`, async () => {
    const {session, source, target, secondTarget} = await ready();
    await session.exportItems(source, source.hello, PIN, signal(), progress);
    const failImport = () => {
      assert.equal(
        session.backup.importStarted,
        true,
        'Lock before sending the first Import',
      );
      throw new Error('Import response unavailable');
    };
    if (failure === 'before-acknowledgement') target.beforeImport = failImport;
    else target.afterImport = failImport;
    await assert.rejects(
      session.importItems(target, target.hello, PIN, signal(), progress),
      /Import response unavailable/,
    );
    assert.equal(target.calls.length, 2);
    assert.equal(
      target.records.size,
      failure === 'before-acknowledgement' ? 0 : 1,
    );
    assert.equal(session.backup.importStarted, true);
    const before = structuredClone(session.backup);
    for (const operation of [
      () => session.addTarget(secondTarget.hello),
      () => session.removeTarget(hex(target.hello.publicKey)),
    ]) {
      await assert.rejects(operation(), /import|started|locked/i);
      assert.deepEqual(session.backup, before);
    }
    const firstArtifact = target.calls.find(
      ([method]) => method === 'importItem',
    )[1];
    const sourceCalls = source.calls.length;
    target.beforeImport = undefined;
    target.afterImport = undefined;
    await session.importItems(target, target.hello, PIN, signal(), progress);
    assert.deepEqual(target.calls[2], ['view', {index: firstArtifact.index}]);
    const attempts = target.calls.filter(
      ([method, request]) =>
        method === 'importItem' &&
        hex(request.index) === hex(firstArtifact.index),
    );
    assert.equal(attempts.length, failure === 'before-acknowledgement' ? 2 : 1);
    assert.deepEqual(attempts.at(-1)[1], firstArtifact);
    assert.equal(source.calls.length, sourceCalls);
    assert.equal(target.records.size, 3);
    assert.equal(session.backup.complete, true);
  });
}

test('successful imports finish directly from acknowledged items', async () => {
  const {session, source, target} = await ready();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  target.list = () => assert.fail('Acknowledged imports need no final List');
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.equal(session.backup.complete, true);
  assert.deepEqual(
    session.backup.targets[0].items.map(item => item.imported),
    [true, true, true],
  );
});

test('Copy reports an export rejection and still imports all other items', async () => {
  const {session, source, target} = await ready();
  source.onExport = request => {
    if (hex(request.index) === hex(index(2)))
      throw new CBORAppletError({code: 'INVALID_PARAMETER'});
  };
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  assert.equal(
    session.backup.targets[0].items[1].issue.reason,
    'INVALID_PARAMETER',
  );
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.equal(session.backup.complete, true);
  assert.deepEqual([...target.records.keys()], [hex(index(1)), hex(index(3))]);
});

test('Copy reports a destination rejection, finishes other items and never retries the rejected write', async () => {
  const {session, source, target} = await ready();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  target.beforeImport = request => {
    if (hex(request.index) === hex(index(2)))
      throw new CBORAppletError({code: 'INVALID_PARAMETER'});
  };
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.equal(session.backup.complete, true);
  assert.deepEqual(
    session.backup.targets[0].items.map(item => item.imported),
    [true, false, true],
  );
  assert.equal(
    session.backup.targets[0].items[1].issue.reason,
    'INVALID_PARAMETER',
  );
  const count = target.calls.length;
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.equal(target.calls.length, count);
});

for (const matching of [true, false])
  test(`Copy settles EXISTS by checking actual opaque contents: ${matching}`, async () => {
    const {session, source, target} = await ready();
    await session.exportItems(source, source.hello, PIN, signal(), progress);
    target.beforeImport = request => {
      if (hex(request.index) === hex(index(2)))
        target.records.set(hex(request.index), {
          ...request,
          data: matching ? request.data : bytes('02deadbeef'),
        });
    };
    await session.importItems(target, target.hello, PIN, signal(), progress);
    const item = session.backup.targets[0].items[1];
    assert.equal(item.imported, matching);
    assert.equal(item.issue?.reason, matching ? undefined : 'Conflict');
    assert.equal(session.backup.targets[0].items[2].imported, true);
    assert.equal(
      target.calls.filter(
        ([method, request]) =>
          method === 'importItem' && hex(request.index) === hex(index(2)),
      ).length,
      1,
    );
  });

test('Copy merges wallet lists and reconciles a lost Set response without replay', async () => {
  const {source, target, root, companion} = groupedFixture({
    type: 'secp256k1',
    wallets: [{addressType: 'evm'}],
  });
  const session = new CardBackupSession();
  await session.readSource(source, source.hello, signal(), [hex(root.index)]);
  await session.addTarget(target.hello);
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  target.records.set(hex(companion.index), {
    index: companion.index,
    metadata: root.index,
    data: Uint8Array.from([
      target.hello.publicKey[1],
      ...encodeCardDerivationRecord({
        index: hex(root.index),
        wallets: [{addressType: 'bitcoin-segwit'}],
      }),
    ]),
  });
  let sets = 0;
  target.set = async request => {
    sets++;
    target.records.get(hex(request.index)).data = Uint8Array.from([
      target.hello.publicKey[1],
      ...request.data,
    ]);
    throw new Error('Lost Set response');
  };
  await assert.rejects(
    session.importItems(target, target.hello, PIN, signal(), progress),
    /Lost Set response/,
  );
  await session.importItems(target, target.hello, PIN, signal(), progress);
  assert.equal(sets, 1);
  assert.equal(session.backup.complete, true);
  assert.deepEqual(
    decodeCardDerivationRecord(
      target.records.get(hex(companion.index)).data.subarray(1),
    ).wallets.map(wallet => wallet.addressType),
    ['bitcoin-segwit', 'evm'],
  );
});
