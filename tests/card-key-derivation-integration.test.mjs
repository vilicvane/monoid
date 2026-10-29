import assert from 'node:assert/strict';
import {test} from 'node:test';

import {ed25519} from '@noble/curves/ed25519';
import {p256} from '@noble/curves/nist';
import {toJS} from 'mobx';

import {CardBackupSession} from '../.bld/app/@components/views/safe/@card/card-backup-session.js';
import {createCardSyncPlans} from '../.bld/app/@components/views/safe/@card/card-sync-plan.js';
import {withCardDerivationRecord} from '../.bld/app/@components/views/safe/card-contents.js';
import {
  encodeCardDerivationRecord,
  getCardDerivationItemIndex,
} from '../.bld/app/@components/views/safe/card-derivations.js';
import {mergeCardItemData} from '../.bld/app/@components/views/safe/card-item-merge.js';
import {
  getCardKeyData,
  importCardKey,
} from '../.bld/app/@components/views/safe/card-key-import.js';
import {scanCardItems} from '../.bld/app/@components/views/safe/scan-card.js';
import {CardItemNotFoundError} from '../.bld/app/@lib/cbor-applet.js';
import {
  encodeCardKeyDerivationRecord,
  getCardKeyDerivationItemIndex,
} from '../.bld/app/@lib/monoid/card-key-derivations.js';
import {CardStore} from '../.bld/app/@services/card-store.js';
import {WalletStorageService} from '../.bld/app/@services/wallet-storage-service.js';

const hex = value => Buffer.from(value).toString('hex');
const bytes = value => Uint8Array.from(Buffer.from(value, 'hex'));
const signal = () => new AbortController().signal;
const seedIndex = '02400000000000000001';
const parameters = [
  {
    type: 'monoid-001',
    curve: 'ed25519',
    context: '  generic signing key ✓  ',
  },
  {
    type: 'monoid-001',
    curve: 'secp256r1',
    context: '  generic signing key ✓  ',
  },
];
const edKey = ed25519.getPublicKey(new Uint8Array(32).fill(1));
const pKey = p256.getPublicKey(1n, false);

function keyRecord(derivations = parameters) {
  const keyDerivationRecord = {index: seedIndex, derivations};
  return {
    index: getCardKeyDerivationItemIndex(seedIndex),
    type: 0x0f02,
    metadata: seedIndex,
    secret: false,
    data: hex(encodeCardKeyDerivationRecord(keyDerivationRecord)),
    keyDerivationRecord,
  };
}

function cardFixture() {
  const root = {
    index: seedIndex,
    type: 'seed',
    secret: true,
    alias: 'Key Seed',
  };
  const records = [
    keyRecord(),
    root,
    {
      index: getCardDerivationItemIndex(seedIndex),
      type: 0x0f01,
      metadata: seedIndex,
      secret: false,
      data: hex(encodeCardDerivationRecord({index: seedIndex, wallets: []})),
    },
  ];
  const reads = [];
  const publicReads = [];
  return {
    root,
    records,
    reads,
    publicReads,
    hello: {
      id: bytes('01010101'),
      publicKey: pKey,
      bundle: false,
      pins: {access: 5, secret: 5},
    },
    async list() {
      return {
        items: records.map(({index, type, metadata, secret, alias}) => ({
          index: bytes(index),
          type,
          secret,
          alias,
          ...(metadata !== undefined && {metadata: bytes(metadata)}),
        })),
      };
    },
    async get({index}) {
      const item = records.find(item => item.index === hex(index));
      assert.equal(item.secret, false, 'never read the Seed secret');
      reads.push(item.index);
      return {data: bytes(item.data)};
    },
    async viewKey(request) {
      publicReads.push(request);
      assert.equal(request.type, 'seed');
      assert.equal(hex(request.index), seedIndex);
      assert.equal(request.derivation.type, 'monoid-001');
      assert.equal(
        new TextDecoder().decode(request.derivation.context),
        parameters[1].context,
      );
      assert.ok(['ed25519', 'secp256r1'].includes(request.derivation.curve));
      return {
        publicKey: request.derivation.curve === 'ed25519' ? edKey : pKey,
      };
    },
  };
}

test('fresh card scan reconstructs both derived keys, preserves them in snapshots and imports persistent Safe candidates', async context => {
  context.mock.method(console, 'info', () => {});
  const applet = cardFixture();
  const items = await scanCardItems(applet, () => {}, signal());
  assert.equal(applet.publicReads.length, 2);
  const store = new CardStore();
  const card = store.set({
    id: hex(applet.hello.id),
    publicKey: hex(pKey),
    bundle: false,
    items,
  });
  const snapshot = card.snapshot();
  const root = snapshot.items.find(item => item.index === seedIndex);
  assert.equal(root.derivedKeys.length, 2);
  assert.deepEqual(
    new Set(
      snapshot.items[0].keyDerivationRecord.derivations.map(JSON.stringify),
    ),
    new Set(parameters.map(JSON.stringify)),
  );
  const derived = root.derivedKeys.find(
    key => key.derivation.curve === 'ed25519',
  );
  derived.derivation.context = 'Changed snapshot';
  assert.equal(
    card.items
      .find(item => item.index === seedIndex)
      .derivedKeys.find(key => key.derivation.curve === 'ed25519').derivation
      .context,
    parameters[0].context,
  );

  const stored = new Map();
  const storage = {
    async get(key) {
      return structuredClone(stored.get(key));
    },
    async set(key, value) {
      stored.set(key, structuredClone(value));
    },
  };
  const wallets = await WalletStorageService.create(storage);
  importCardKey(
    wallets,
    getCardKeyData(
      {
        ...card.snapshot().items.find(item => item.index === seedIndex),
        alias: 'Key Seed',
      },
      [],
    ),
  );
  await wallets.flush();
  const reloaded = await WalletStorageService.create(storage);
  const saved = toJS(reloaded.keys[0].derivedKeys);
  assert.equal(saved.length, 2);
  assert.deepEqual(
    new Set(saved.map(key => JSON.stringify(key.derivation))),
    new Set(parameters.map(JSON.stringify)),
  );
  assert.equal(
    saved.find(key => key.derivation.curve === 'ed25519').publicKey,
    hex(edKey),
  );
  assert.equal(
    saved.find(key => key.derivation.curve === 'secp256r1').publicKey,
    hex(pKey),
  );
  assert.ok(saved.every(key => !('account' in key)));
  assert.deepEqual(toJS(reloaded.keys[0].wallets), []);
});

test('saving a derived key updates Safe persistently and rejects a conflicting public key before mutation', async context => {
  context.mock.method(console, 'info', () => {});
  const writes = [];
  const service = new WalletStorageService(
    {
      async set(_key, value) {
        writes.push(structuredClone(value));
      },
    },
    [{index: seedIndex, type: 'seed', alias: 'Key Seed', wallets: []}],
  );
  const derived = {
    publicKey: hex(pKey),
    derivation: parameters[1],
  };
  await service.addDerivedKeys(seedIndex, derived);
  await service.addDerivedKeys(seedIndex, derived);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0][0].derivedKeys, [derived]);
  const before = toJS(service.keys);
  await assert.rejects(
    () =>
      service.addDerivedKeys(seedIndex, {
        ...derived,
        publicKey: hex(p256.getPublicKey(2n, false)),
      }),
    /does not match|conflict/i,
  );
  assert.deepEqual(toJS(service.keys), before);
  assert.equal(writes.length, 1);
});

test('a conflicting derived key aborts an import before changing the alias or saved keys', async context => {
  context.mock.method(console, 'info', () => {});
  const service = new WalletStorageService({async set() {}}, [
    {
      index: seedIndex,
      type: 'seed',
      alias: 'Saved name',
      wallets: [],
      derivedKeys: [{derivation: parameters[1], publicKey: hex(pKey)}],
    },
  ]);
  const before = toJS(service.keys);
  const incoming = getCardKeyData({
    index: seedIndex,
    type: 'seed',
    alias: 'Changed name',
    derivedKeys: [
      {derivation: parameters[0], publicKey: hex(edKey)},
      {derivation: parameters[1], publicKey: hex(p256.getPublicKey(2n, false))},
    ],
  });
  assert.throws(() => importCardKey(service, incoming), /conflict/i);
  assert.deepEqual(toJS(service.keys), before);
});

test('empty and whitespace contexts remain distinct after Safe persistence', async context => {
  context.mock.method(console, 'info', () => {});
  const stored = new Map();
  const storage = {
    async get(key) {
      return structuredClone(stored.get(key));
    },
    async set(key, value) {
      stored.set(key, structuredClone(value));
    },
  };
  const service = await WalletStorageService.create(storage);
  importCardKey(
    service,
    getCardKeyData({
      index: seedIndex,
      type: 'seed',
      alias: 'Contexts',
      derivedKeys: ['', ' ', 'é', 'e\u0301'].map(context => ({
        derivation: {type: 'monoid-001', curve: 'secp256r1', context},
        publicKey: hex(pKey),
      })),
    }),
  );
  await service.flush();
  const reloaded = await WalletStorageService.create(storage);
  assert.deepEqual(
    reloaded.keys[0].derivedKeys.map(key => key.derivation.context),
    ['', ' ', 'é', 'e\u0301'],
  );
});

test('unknown key metadata stays opaque and cannot overwrite or merge with a recognized record', async () => {
  const applet = cardFixture();
  applet.records[0].data = 'ff';
  const items = await scanCardItems(applet, () => {}, signal());
  const unknown = items.find(item => item.index === applet.records[0].index);
  assert.ok(unknown);
  assert.equal(unknown.keyDerivationRecord, undefined);
  assert.equal(
    items.find(item => item.index === seedIndex).derivedKeys,
    undefined,
  );
  assert.deepEqual(applet.publicReads, []);
  const opaque = withCardDerivationRecord({...applet.records[0]});
  assert.equal(opaque.data, 'ff');
  assert.equal(
    opaque.keyDerivationRecord,
    undefined,
    'stale decoded fields cannot authorize a merge',
  );
  assert.throws(() => mergeCardItemData(opaque, keyRecord()), /conflict/i);
});

test('key metadata transport failure and interrupted derivation remain failures without continuing to another key', async () => {
  const applet = cardFixture();
  const failure = new Error('NFC response lost');
  applet.get = async () => {
    throw failure;
  };
  await assert.rejects(
    scanCardItems(applet, () => {}, signal()),
    error => error === failure,
  );
  assert.deepEqual(applet.publicReads, []);

  const interrupted = cardFixture();
  const controller = new AbortController();
  const viewKey = interrupted.viewKey.bind(interrupted);
  interrupted.viewKey = async request => {
    const response = await viewKey(request);
    controller.abort();
    return response;
  };
  await assert.rejects(
    scanCardItems(interrupted, () => {}, controller.signal),
    {name: 'AbortError'},
  );
  assert.equal(interrupted.publicReads.length, 1);
});

test('Key derivation records merge only within the Seed bundle and follow their root when transferred', () => {
  const root = {
    index: seedIndex,
    type: 'seed',
    secret: true,
    exported: {data: 'ab'},
  };
  const card = (id, bundle, items) => ({id, publicKey: id, bundle, items});
  const plans = createCardSyncPlans([
    card('1', 'A', [keyRecord([parameters[0]]), root]),
    card('2', 'A', [keyRecord([parameters[1]]), root]),
    card('3', 'A', []),
    card('4', 'B', []),
  ]);
  const merged = plans[0].items.find(item => item.keyDerivationRecord);
  assert.deepEqual(
    new Set(merged.keyDerivationRecord.derivations.map(JSON.stringify)),
    new Set(parameters.map(JSON.stringify)),
  );
  assert.deepEqual(
    plans[2].operations.map(value => [value.kind, value.after.index]),
    [
      ['import', seedIndex],
      ['create', merged.index],
    ],
  );
  assert.deepEqual(plans[3].items, []);
  const malformed = withCardDerivationRecord({...keyRecord(), data: 'ff'});
  const conflict = createCardSyncPlans([
    card('1', 'A', [root, keyRecord()]),
    card('2', 'A', [root, malformed]),
  ]);
  assert.ok(
    conflict.every(plan =>
      plan.issues.some(
        issue => issue.index === malformed.index && issue.reason === 'Conflict',
      ),
    ),
  );
  assert.ok(
    conflict.every(
      plan =>
        !plan.operations.some(
          operation => operation.after.index === malformed.index,
        ),
    ),
  );
});

test('Copy selects both Seed companions, preserves public key metadata and imports the Seed first', async () => {
  const source = cardFixture();
  const exported = [];
  const imported = [];
  source.authenticate = async () => {};
  source.exportItem = async ({index}) => {
    exported.push(hex(index));
    const item = source.records.find(item => item.index === hex(index));
    return {
      ...(item.metadata && {metadata: bytes(item.metadata)}),
      data: bytes('aabb'),
    };
  };
  const targetHello = {
    ...source.hello,
    id: bytes('02020202'),
    publicKey: p256.getPublicKey(2n, false),
  };
  const target = {
    async authenticate() {},
    async view() {
      throw new CardItemNotFoundError({code: 'NOT_FOUND'});
    },
    async importItem(request) {
      imported.push(request);
    },
  };
  const copy = new CardBackupSession();
  await copy.readSource(source, source.hello, signal(), [seedIndex]);
  assert.deepEqual(
    copy.backup.items.filter(item => item.selected).map(item => item.index),
    [
      seedIndex,
      getCardKeyDerivationItemIndex(seedIndex),
      getCardDerivationItemIndex(seedIndex),
    ],
  );
  await copy.addTarget(targetHello);
  await copy.confirmTargets();
  await copy.exportItems(source, source.hello, 'Secret-42', signal(), () => {});
  await copy.importItems(target, targetHello, 'Secret-42', signal(), () => {});
  assert.deepEqual(
    imported.map(value => hex(value.index)),
    exported,
  );
  assert.equal(exported[0], seedIndex);
  assert.equal(hex(imported[1].metadata), seedIndex);
  assert.equal(
    copy.backup.items.find(item => item.index === exported[1]).secret,
    false,
  );
  assert.equal(copy.backup.complete, true);
});
