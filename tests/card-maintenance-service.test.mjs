import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {beforeEach, mock, test} from 'node:test';

import {encode} from 'cbor2';

import {
  CBORAppletError,
  CardItemExistsError,
  CardItemNotFoundError,
} from '../.bld/app/@lib/cbor-applet.js';

import {pinClock} from './helpers/held-pins.mjs';

let replacement;
let scannedHello;
const bundleHashes = ['identity-image', 'library-image', 'monoid-image'];
const catalog = [
  {stage: 'identity', appletAid: 'f06d6f6e6f69640001'},
  {stage: 'library'},
  {
    stage: 'otp',
    appletAid: 'f06d6f6e6f69640501',
    optional: true,
    dependencies: ['library', 'monoid'],
  },
  {
    stage: 'monoid',
    appletAid: 'f06d6f6e6f69640201',
    dependencies: ['identity', 'library'],
  },
  {
    stage: 'security-key',
    appletAid: 'f06d6f6e6f69640301',
    instanceAid: 'a0000006472f0001',
    optional: true,
    dependencies: ['library', 'monoid'],
  },
];
function dependents(stages) {
  const affected = new Set(stages);
  for (const applet of catalog) {
    if (applet.dependencies?.some(stage => affected.has(stage)))
      affected.add(applet.stage);
  }
  return catalog.filter(
    applet => affected.has(applet.stage) && !stages.includes(applet.stage),
  );
}

mock.module('../.bld/app/@lib/global-platform/card-information.js', {
  namedExports: {readCardInformation: async () => information},
});
mock.module('capacitor-isodep-nfc', {
  namedExports: {
    IsoDepNfc: {
      transceive: async ({data}) => ({
        data: data[1] === 0xa4 ? [0x90, 0] : [...encode(scannedHello), 0x90, 0],
      }),
    },
  },
});

mock.module('../.bld/app/@lib/monoid/install.js', {
  namedExports: {
    getAppletCatalog: () => catalog,
    getAppletDependents: dependents,
    getMonoidAppletBundleHashes: () => [...bundleHashes],
    getMonoidAppletBundleHash: stage =>
      bundleHashes[
        ['identity', 'library', 'monoid', 'security-key'].indexOf(stage)
      ],
    getBundledMonoidAppletAid: () => 'f06d6f6e6f69640201',
    getCardMaintenanceFingerprint: information => {
      if (!information.cplc)
        throw new Error('Card production information required');
      return `physical:${information.cplc.icSerialNumber}`;
    },
    replaceMonoidApplets: async (sessionId, options) =>
      replacement(sessionId, options),
  },
});

const {CardMaintenanceService, assertCardMaintenanceBundleRecovery} =
  await import('../.bld/app/@services/card-maintenance-service.js');
const bytes = hex => new Uint8Array(Buffer.from(hex, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const aid = bytes('f06d6f6e6f69640201');
const identity = bytes(`04${'11'.repeat(64)}`);
const information = {
  cardManagerAid: 'a000000151000000',
  secureChannels: [],
  cplc: {icSerialNumber: '12345678'},
};
const hello = {
  version: 0,
  id: bytes('01020304'),
  publicKey: identity,
  bundle: false,
  authority: false,
  alias: false,
  allowPeerExtension: false,
  pins: {access: 5, secret: 5},
};
const sourceItems = [
  {index: bytes('02400000000000000001'), secret: true},
  {
    index: bytes('0f010000000000000002'),
    metadata: bytes(''),
    alias: '',
    secret: false,
  },
  {
    index: bytes('ffff0000000000000003'),
    metadata: bytes('aa'),
    alias: 'Note',
    secret: false,
  },
];

function storageFixture() {
  let saved;
  return {
    writes: [],
    failWrite: false,
    corruptRead: false,
    async get() {
      const value = structuredClone(saved);
      if (this.corruptRead && value) value.operations = [];
      return value;
    },
    async set(key, value) {
      assert.equal(key, 'cardMaintenance');
      if (this.failWrite) throw new Error('Disk full');
      saved = structuredClone(value);
      this.writes.push(structuredClone(value));
      await this.afterSet?.(value);
    },
    mutate(callback) {
      callback(saved);
    },
  };
}

function cardFixture() {
  const card = {
    aid,
    state: structuredClone(hello),
    items: structuredClone(sourceItems),
    grants: [],
    grantListCalls: [],
    listCalls: [],
    exports: [],
    imports: [],
    restored: new Map(),
    failExport: -1,
    failImport: -1,
    mismatchList: false,
    exportedBytes: 144,
    async hello() {
      return structuredClone(this.state);
    },
    async list(request) {
      this.listCalls.push(request);
      return {
        items: structuredClone(
          this.mismatchList ? this.items.slice(1) : this.items,
        ),
      };
    },
    async listAppletGrants(request) {
      this.grantListCalls.push(request);
      return {grants: structuredClone(this.grants)};
    },
    async setAppletGrant(request) {
      if (this.failGrant) throw new Error('Grant interrupted');
      this.grants = [
        ...this.grants.filter(grant => hex(grant.aid) !== hex(request.aid)),
        {...structuredClone(request), tokenHash: new Uint8Array(32).fill(0x55)},
      ];
    },
    async get({index}) {
      return {data: this.restored.get(hex(index))?.data ?? bytes('abcd')};
    },
    async exportItem(request) {
      assert.equal(hex(request.recipientPublicKey), hex(this.state.publicKey));
      assert.equal(
        this.exports.length === this.failExport,
        false,
        'Export interrupted',
      );
      this.exports.push(request);
      const item = this.items.find(
        item => hex(item.index) === hex(request.index),
      );
      const data = new Uint8Array(this.exportedBytes);
      data[0] = 1;
      data[1] = this.exports.length;
      return {metadata: item.metadata, alias: item.alias, data};
    },
    async view({index}) {
      const item = this.restored.get(hex(index));
      if (!item) throw new CardItemNotFoundError({code: 'NOT_FOUND'});
      return item;
    },
    async importItem(request) {
      this.imports.push(request);
      if (this.restored.has(hex(request.index)))
        throw new CardItemExistsError({code: 'EXISTS'});
      this.restored.set(
        hex(request.index),
        structuredClone(
          this.items.find(item => hex(item.index) === hex(request.index)),
        ),
      );
      if (this.imports.length === this.failImport) throw new Error('Tag lost');
    },
  };
  return card;
}

function bundleRecovery(card) {
  const source = {
    id: '11223344',
    publicKey: `04${'22'.repeat(64)}`,
    bundle: hex(card.state.bundle),
  };
  const data = new Uint8Array(160);
  data[0] = 2;
  data.set(bytes(source.bundle), 1);
  data.set(bytes(source.publicKey), 33);
  return {
    source,
    items: card.items.map(item => ({
      index: hex(item.index),
      key: item.metadata === undefined ? undefined : hex(item.metadata),
      alias: item.alias,
      secret: item.secret,
      data: hex(data),
    })),
  };
}

beforeEach(() => {
  bundleHashes.splice(
    0,
    bundleHashes.length,
    'identity-image',
    'library-image',
    'monoid-image',
  );
  scannedHello = structuredClone(hello);
  replacement = async (_session, options) => {
    for (const checkpoint of [
      'remove-monoid-instance',
      'remove-monoid-package',
      'install',
      'verify',
    ]) {
      await options.onCheckpoint(checkpoint);
    }
    return structuredClone(hello);
  };
});

test('procedure Secret PINs are isolated by public key and never persisted or restored', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  const first = {id: hex(card.state.id), publicKey: hex(card.state.publicKey)};
  const other = {...first, publicKey: `04${'99'.repeat(64)}`};
  service.holdSecretPIN(first, 'Secret-42');
  assert.equal(service.secretPIN(first), 'Secret-42');
  assert.equal(service.secretPIN(other), undefined);
  service.holdSecretPIN(other, 'Other-43');
  service.dropSecretPIN(first);
  assert.equal(service.secretPIN(first), undefined);
  assert.equal(service.secretPIN(other), 'Other-43');
  service.holdSecretPIN(first, 'Secret-42');
  const operation = await service.prepare(card, {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  await service.replace('session', operation.id);
  assert.equal(service.secretPIN(first), 'Secret-42');
  assert.doesNotMatch(
    JSON.stringify(storage.writes),
    /Secret-42|Other-43|secretPIN/,
  );
  const restarted = await CardMaintenanceService.create(storage);
  assert.equal(restarted.secretPIN(first), undefined);
  assert.equal(restarted.secretPIN(other), undefined);
  await service.restore(card, operation.id);
  assert.equal(service.secretPIN(first), undefined);
  assert.equal(service.secretPIN(other), 'Other-43');
});

test('maintenance expiry clears PINs without changing saved operations; hiding cancels late holds', async t => {
  const clock = pinClock(t);
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const {preparations} = await batchFixture(service);
  await service.saveBundleRecoveryBatch(preparations);
  const saved = await storage.get();
  for (const {operation} of preparations)
    service.holdSecretPIN(operation.card, 'Secret-42');
  clock.elapse(5 * 60_000);
  for (const {operation} of preparations)
    assert.equal(service.secretPIN(operation.card), undefined);
  const hold = service.secretPINWriter();
  const card = preparations[0].operation.card;
  hold(card, 'Secret-42');
  assert.equal(service.secretPIN(card), 'Secret-42');
  clock.visibility('hidden');
  clock.visibility('visible');
  hold(card, 'Secret-42');
  assert.equal(service.secretPIN(card), undefined);
  assert.deepEqual(await storage.get(), saved);
  assert.equal(service.operations.length, 2);
});

test('discarding a prepared batch drops all target PINs but preserves unrelated cards', async () => {
  const service = await CardMaintenanceService.create(storageFixture());
  const {preparations} = await batchFixture(service);
  await service.saveBundleRecoveryBatch(preparations);
  for (const {operation} of preparations)
    service.holdSecretPIN(operation.card, 'Secret-42');
  const unrelated = {publicKey: `04${'99'.repeat(64)}`};
  service.holdSecretPIN(unrelated, 'Other-43');
  await service.discardPrepared(preparations[0].operation.id);
  for (const {operation} of preparations)
    assert.equal(service.secretPIN(operation.card), undefined);
  assert.equal(service.secretPIN(unrelated), 'Other-43');
});

test('backs up every resource with exact optional metadata and no PIN before replacement', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  const progress = [];
  const operation = await service.prepare(card, {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
    onProgress: value => progress.push(value),
  });
  assert.equal(operation.archive.items.length, 3);
  assert.deepEqual(card.listCalls, [{}, {}]);
  assert.equal(card.exports.length, 3);
  assert.equal(operation.archive.items[0].key, undefined);
  assert.equal(operation.archive.items[1].key, '');
  assert.equal(operation.archive.items[1].alias, '');
  assert.equal(operation.archive.items[2].index, hex(sourceItems[2].index));
  assert.equal(JSON.stringify(await storage.get()).includes('pin'), false);
  assert.deepEqual(progress, [
    {stage: 'backup', completed: 0, total: 3},
    {stage: 'backup', completed: 1, total: 3},
    {stage: 'backup', completed: 2, total: 3},
    {stage: 'backup', completed: 3, total: 3},
    {stage: 'verifying-backup'},
  ]);
  replacement = async (_session, options) => {
    assert.equal((await storage.get()).operations[0].archive.items.length, 3);
    await options.onCheckpoint('remove-monoid-instance');
    assert.equal(
      (await storage.get()).operations[0].checkpoint,
      'remove-monoid-instance',
    );
    return structuredClone(hello);
  };
  await service.replace('session', operation.id);
  assert.equal(service.get(operation.id).phase, 'restore');
});

test('applet access preserves its original scope and binds a new token after data recovery', async () => {
  for (const bundle of [false, new Uint8Array(32).fill(0x42)]) {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
    const card = cardFixture();
    card.state.bundle = bundle;
    const scope = {
      aid: bytes('a0000006472f0001'),
      types: [[-3839, true]],
      seed: {index: bytes('02400000000000000001'), domain: bytes('deadbeef')},
    };
    card.grants = [{...scope, tokenHash: new Uint8Array(32)}];
    let operation = await service.prepare(card, {
      mode: 'update',
      cardInformation: information,
      appletAid: hex(aid),
      selectedOptionalStages: ['security-key'],
    });
    if (bundle)
      operation = await service.saveBundleRecovery(
        operation,
        bundleRecovery(card),
      );
    assert.equal(operation.grants.length, 1);
    assert.equal(
      JSON.stringify(await storage.get()).includes('tokenHash'),
      false,
    );
    replacement = async (_session, options) => {
      assert.deepEqual(options.selectedOptionalStages, ['security-key']);
      return structuredClone(card.state);
    };
    await service.replace('session', operation.id);
    card.grants = [];
    await service.restore(card, operation.id);
    const {tokenHash, ...restored} = card.grants[0];
    assert.deepEqual(restored, {...scope, keys: undefined});
    assert.deepEqual(tokenHash, new Uint8Array(32).fill(0x55));
    if (bundle) assert.deepEqual(card.exports, []);
    assert.equal(card.imports.length, sourceItems.length);
    assert.equal(service.get(operation.id), undefined);
  }
});

test('grant read failure prevents automatic replacement without pretending grants are absent', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.listAppletGrants = async () => {
    throw new Error('Tag lost');
  };
  await assert.rejects(
    service.prepare(card, {
      mode: 'update',
      cardInformation: information,
      appletAid: hex(aid),
    }),
    /Tag lost/,
  );
  assert.deepEqual(card.exports, []);
  assert.equal(storage.writes.length, 0);
  assert.equal(service.operations.length, 0);
});

test('pending Bundle applet access cannot be overwritten by another maintenance operation', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(0x42);
  card.grants = [
    {
      aid: bytes('a0000006472f0001'),
      types: [[-3839, true]],
      seed: {index: sourceItems[0].index, domain: bytes('00ff80')},
      tokenHash: new Uint8Array(32),
    },
  ];
  const options = {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  };
  const operation = await service.prepare(card, options);
  await service.saveBundleRecovery(operation, bundleRecovery(card));
  const recovery = structuredClone(await storage.get());
  await assert.rejects(service.prepare(card, options), /Continue the existing/);
  assert.deepEqual(await storage.get(), recovery);
  assert.equal(service.get(operation.id).phase, 'ready');
  assert.equal(service.get(operation.id).grants.length, 1);
});

test('optional applet replacement preserves items even on a Bundle card and restores only affected access', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(4);
  const scope = {
    aid: bytes('a0000006472f0001'),
    types: [[-3839, true]],
    seed: {index: bytes('02400000000000000001'), domain: bytes('aabb')},
  };
  card.grants = [{...scope, tokenHash: new Uint8Array(32)}];
  const operation = await service.prepare(card, {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
    selectedOptionalStages: ['security-key'],
    replaceStages: ['security-key'],
  });
  assert.equal(operation.archive, undefined);
  assert.deepEqual(card.exports, []);
  replacement = async (_session, options) => {
    assert.deepEqual(options.replaceStages, ['security-key']);
    return structuredClone(card.state);
  };
  await service.replace('session', operation.id);
  assert.equal(service.get(operation.id).phase, 'restore');
  await service.restore(card, operation.id);
  assert.equal(card.imports.length, 0);
  assert.equal(service.get(operation.id), undefined);
  assert.equal(
    service.isUpdateAvailable(card.state),
    undefined,
    'skipped base packages are never marked current',
  );
});

for (const kind of ['empty card', 'optional without grants']) {
  test(`${kind} stays restartable through setup and removes its empty recovery only after restore verification`, async () => {
    const storage = storageFixture();
    let service = await CardMaintenanceService.create(storage);
    const card = cardFixture();
    if (kind === 'empty card') card.items = [];
    const operation = await service.prepare(card, {
      mode: 'reinstall',
      cardInformation: information,
      appletAid: hex(aid),
      ...(kind === 'optional without grants' && {
        selectedOptionalStages: ['security-key'],
        replaceStages: ['security-key'],
      }),
    });
    await service.replace('session', operation.id);
    assert.equal(service.get(operation.id).phase, 'restore');
    service = await CardMaintenanceService.create(storage);
    assert.equal(service.get(operation.id).phase, 'restore');
    const archive = JSON.stringify(service.get(operation.id).archive);
    await service.restart(operation.id);
    service = await CardMaintenanceService.create(storage);
    assert.equal(service.get(operation.id).restarted, true);
    await service.replace('session', operation.id);
    assert.equal(service.get(operation.id).phase, 'restore');
    assert.equal(JSON.stringify(service.get(operation.id).archive), archive);
    assert.equal((await service.restore(card, operation.id)).complete, true);
    assert.equal(service.get(operation.id), undefined);
    assert.equal(service.matchOperation({hello: card.state}), undefined);
    assert.deepEqual((await storage.get()).operations, []);
    assert.deepEqual(card.imports, []);
    assert.equal(
      (await CardMaintenanceService.create(storage)).operations.length,
      0,
    );
    if (kind === 'empty card')
      assert.equal(service.isUpdateAvailable(card.state), false);
    else assert.equal(card.exports.length, 0);
  });
}

test('loading retains empty recovery still awaiting setup and restore verification, along with uncertain checkpoints', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.items = [];
  await service.prepare(card, {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
  });
  storage.mutate(state => {
    const template = state.operations[0];
    state.operations = [
      {...template, id: 'empty', phase: 'restore'},
      {
        ...template,
        id: 'uncertain',
        phase: 'replacing',
        checkpoint: 'remove-monoid-package',
      },
    ];
  });
  const before = await storage.get();
  const restarted = await CardMaintenanceService.create(storage);
  assert.deepEqual(
    restarted.operations.map(operation => operation.id),
    ['empty', 'uncertain'],
  );
  assert.deepEqual(await storage.get(), before);
});

for (const phase of ['manual-restore', 'obsolete-phase']) {
  test(`loading discards ${phase} and rewrites storage while preserving a current recovery`, async () => {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
    const operation = await service.prepare(cardFixture(), {
      mode: 'reinstall',
      cardInformation: information,
      appletAid: hex(aid),
    });
    await service.replace('session', operation.id);
    const normal = (await storage.get()).operations[0];
    storage.mutate(state => {
      state.operations.unshift({
        ...normal,
        id: 'obsolete',
        phase,
        checkpoint: 'verify',
        archive: undefined,
        // Obsolete records are discarded before their payloads are validated.
        grants: [],
        grantsChecksum: 'invalid',
        card: {...normal.card, publicKey: `04${'55'.repeat(64)}`},
      });
    });
    const before = await storage.get();
    const writes = storage.writes.length;
    const restarted = await CardMaintenanceService.create(storage);
    assert.deepEqual(restarted.operations, [normal]);
    assert.equal(storage.writes.length, writes + 1);
    assert.deepEqual(await storage.get(), {...before, operations: [normal]});
    await CardMaintenanceService.create(storage);
    assert.equal(storage.writes.length, writes + 1);
  });
}

test('corrupt recovery payloads cannot masquerade as empty automatic recovery during startup cleanup', async () => {
  const checksum = value =>
    `0x${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
  for (const changes of [
    {archive: {items: [], checksum: 'invalid'}},
    {archive: {items: {}, checksum: checksum({})}},
    {archive: null},
    {grants: [], grantsChecksum: 'invalid'},
    {grants: {}, grantsChecksum: checksum({})},
    {grants: null},
  ]) {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
    await service.prepare(cardFixture(), {
      mode: 'reinstall',
      cardInformation: information,
      appletAid: hex(aid),
      selectedOptionalStages: ['security-key'],
      replaceStages: ['security-key'],
    });
    storage.mutate(state =>
      Object.assign(state.operations[0], {phase: 'restore'}, changes),
    );
    const before = await storage.get();
    await assert.rejects(
      CardMaintenanceService.create(storage),
      /integrity check|recovery data is invalid/,
    );
    assert.deepEqual(await storage.get(), before);
  }
});

test('a required recovery archive missing from a stored restore task is not silently discarded', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  await service.prepare(cardFixture(), {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
  });
  storage.mutate(state => {
    state.operations[0].phase = 'restore';
    delete state.operations[0].archive;
  });
  const before = await storage.get();
  await assert.rejects(
    CardMaintenanceService.create(storage),
    /recovery archive is missing/,
  );
  assert.deepEqual(await storage.get(), before);
});

test('optional-only replacement cannot skip a known required applet update', async () => {
  const service = await CardMaintenanceService.create(storageFixture());
  const card = cardFixture();
  await service.recordInstallation(card.state, {library: true, monoid: true});
  bundleHashes[1] = 'new-library-image';
  await assert.rejects(
    service.prepare(card, {
      mode: 'update',
      cardInformation: information,
      appletAid: hex(aid),
      selectedOptionalStages: ['security-key'],
      replaceStages: ['security-key'],
    }),
    /Update required applets first/,
  );
  assert.deepEqual(card.exports, []);
  assert.equal(service.operations.length, 0);
});

test('grant failure retains the archive and original domain until explicit recovery succeeds', async () => {
  const storage = storageFixture();
  let service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  const scope = {
    aid: bytes('a0000006472f0001'),
    types: [[-3839, true]],
    seed: {index: bytes('02400000000000000001'), domain: bytes('00ff80')},
  };
  card.grants = [{...scope, tokenHash: new Uint8Array(32)}];
  const operation = await service.prepare(card, {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
    selectedOptionalStages: ['security-key'],
  });
  await service.replace('session', operation.id);
  card.failGrant = true;
  card.grants = [];
  await assert.rejects(
    service.restore(card, operation.id),
    /Grant interrupted/,
  );
  service = await CardMaintenanceService.create(storage);
  assert.equal(
    service.get(operation.id).archive.items.length,
    sourceItems.length,
  );
  card.failGrant = false;
  await service.restore(card, operation.id);
  assert.deepEqual(card.grants[0].seed.domain, scope.seed.domain);
  assert.equal(service.get(operation.id), undefined);
});

test('grant progress counts only acknowledged writes and verification failure retains recovery', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.grants = [1, 2].map(id => ({
    aid: bytes(`a0000006472f000${id}`),
    types: [[-3839, true]],
    tokenHash: new Uint8Array(32),
  }));
  const operation = await service.prepare(card, {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  await service.replace('session', operation.id);
  card.grants = [];
  const progress = [];
  const firstStarted = Promise.withResolvers();
  const firstACK = Promise.withResolvers();
  const setGrant = card.setAppletGrant.bind(card);
  let attempted = 0;
  card.setAppletGrant = async request => {
    if (++attempted === 2) throw new Error('Grant interrupted');
    firstStarted.resolve();
    await firstACK.promise;
    await setGrant(request);
  };
  const restoring = service.restore(card, operation.id, update =>
    progress.push(update),
  );
  const rejected = assert.rejects(restoring, /Grant interrupted/);
  await firstStarted.promise;
  assert.deepEqual(progress.at(-1), {
    stage: 'restoring-grants',
    completed: 0,
    total: 2,
  });
  assert.ok(service.get(operation.id).archive);
  firstACK.resolve();
  await rejected;
  assert.deepEqual(progress.slice(-3), [
    {stage: 'verifying-restore'},
    {stage: 'restoring-grants', completed: 0, total: 2},
    {stage: 'restoring-grants', completed: 1, total: 2},
  ]);
  assert.ok(service.get(operation.id).archive);

  card.setAppletGrant = setGrant;
  const listGrants = card.listAppletGrants.bind(card);
  card.listAppletGrants = async request => {
    const result = await listGrants(request);
    if (progress.at(-1).stage === 'verifying-restore') return result;
    return {grants: result.grants.slice(1)};
  };
  progress.length = 0;
  await assert.rejects(
    service.restore(card, operation.id, update => progress.push(update)),
    /Could not verify applet access/,
  );
  assert.deepEqual(progress.slice(-4), [
    {stage: 'restoring-grants', completed: 0, total: 2},
    {stage: 'restoring-grants', completed: 1, total: 2},
    {stage: 'restoring-grants', completed: 2, total: 2},
    {stage: 'verifying-grants'},
  ]);
  assert.ok(service.get(operation.id).archive);
  card.listAppletGrants = listGrants;
  await service.restore(card, operation.id);
  assert.equal(service.get(operation.id), undefined);
});

test('cancellation after a grant ACK reports that grant without starting the next one or losing recovery', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.grants = [1, 2].map(id => ({
    aid: bytes(`a0000006472f000${id}`),
    types: [[-3839, true]],
    tokenHash: new Uint8Array(32),
  }));
  const operation = await service.prepare(card, {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  await service.replace('session', operation.id);
  card.grants = [];
  const progress = [];
  const controller = new AbortController();
  const setGrant = card.setAppletGrant.bind(card);
  card.setAppletGrant = async request => {
    await setGrant(request);
    controller.abort();
  };
  await assert.rejects(
    service.restore(
      card,
      operation.id,
      update => progress.push(update),
      controller.signal,
    ),
    {name: 'AbortError'},
  );
  assert.equal(card.grants.length, 1);
  assert.deepEqual(progress.at(-1), {
    stage: 'restoring-grants',
    completed: 1,
    total: 2,
  });
  assert.ok(service.get(operation.id).archive);
});

test('backup verification is a separate stage and a mismatch never saves an archive', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  const progress = [];
  const list = card.list.bind(card);
  card.list = async request => {
    if (card.listCalls.length) {
      assert.deepEqual(progress.at(-1), {stage: 'verifying-backup'});
      card.mismatchList = true;
    }
    return list(request);
  };
  await assert.rejects(
    service.prepare(card, {
      mode: 'update',
      cardInformation: information,
      appletAid: hex(aid),
      onProgress: update => progress.push(update),
    }),
    /does not match/,
  );
  assert.deepEqual(service.operations, []);
  assert.deepEqual(storage.writes, []);
});

test('corrupt grant recovery scopes fail before deletion or authorization changes', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.grants = [
    {
      aid: bytes('a0000006472f0001'),
      types: [[-3839, true]],
      tokenHash: new Uint8Array(32),
    },
  ];
  const operation = await service.prepare(card, {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  await service.replace('session', operation.id);
  storage.mutate(state => {
    state.operations[0].grants[0] = 'a0';
  });
  await assert.rejects(
    CardMaintenanceService.create(storage),
    /recovery data is invalid/,
  );
});

test('a failed export or oversized Import prevents committing a maintenance operation', async () => {
  for (const kind of ['interrupted', 'oversized']) {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
    const card = cardFixture();
    if (kind === 'interrupted') card.failExport = 1;
    else card.exportedBytes = 8192;
    await assert.rejects(
      service.prepare(card, {
        mode: 'reinstall',
        cardInformation: information,
        appletAid: hex(aid),
      }),
      kind === 'interrupted' ? /Export interrupted/ : /too large/,
    );
    assert.equal(storage.writes.length, 0);
    assert.equal(service.operations.length, 0);
  }
});

test('a same-ID reset cannot inherit an old maintenance operation through its chip fingerprint', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  const operation = await service.prepare(card, {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
  });
  assert.equal(service.matchOperation({hello: card.state}).id, operation.id);
  const reset = {
    ...card.state,
    publicKey: bytes(`04${'99'.repeat(64)}`),
    bundle: false,
    pins: {access: false, secret: false},
  };
  assert.equal(
    service.matchOperation({hello: reset, cardInformation: information}),
    undefined,
  );
  assert.equal(
    service.get(operation.id).card.publicKey,
    hex(card.state.publicKey),
  );
});

test('storage acknowledgement and read-back verification are required before deletion', async () => {
  for (const failure of ['write', 'read']) {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
    storage.failWrite = failure === 'write';
    storage.corruptRead = failure === 'read';
    await assert.rejects(
      service.prepare(cardFixture(), {
        mode: 'update',
        cardInformation: information,
        appletAid: hex(aid),
      }),
      failure === 'write' ? /Disk full/ : /verify the saved/,
    );
    assert.equal(service.operations.length, 0);
  }
});

for (const mode of ['update', 'reinstall', 'fresh']) {
  test(`${mode} preflight failure discards only the untouched preparation`, async () => {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
    const operation =
      mode === 'fresh'
        ? await service.prepareFresh(information, hello)
        : await service.prepare(cardFixture(), {
            mode,
            cardInformation: information,
            appletAid: hex(aid),
          });
    const failure = new Error('Wrong card');
    replacement = async () => {
      throw failure;
    };
    await assert.rejects(
      service.replace('session', operation.id),
      error => error === failure,
    );
    assert.equal(service.get(operation.id), undefined);
    assert.equal(
      service.matchOperation({hello, cardInformation: information}),
      undefined,
    );
    assert.deepEqual((await storage.get()).operations, []);
    assert.equal(
      (await CardMaintenanceService.create(storage)).operations.length,
      0,
    );
  });
}

test('package validation failure discards an unstarted archive before entering replacement', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const operation = await service.prepare(cardFixture(), {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  bundleHashes[2] = 'changed-after-preparation';
  let called = false;
  replacement = async () => {
    called = true;
  };
  await assert.rejects(
    service.replace('session', operation.id),
    /package changed/,
  );
  assert.equal(called, false);
  assert.equal(service.get(operation.id), undefined);
  assert.deepEqual((await storage.get()).operations, []);
});

for (const stage of ['before replace', 'during preflight']) {
  test(`cancellation ${stage} discards an untouched fresh plan without authorizing a checkpoint`, async () => {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
    const operation = await service.prepareFresh(information, hello);
    const controller = new AbortController();
    if (stage === 'before replace') controller.abort();
    let entered = false;
    replacement = async (_session, options) => {
      entered = true;
      controller.abort();
      options.signal.throwIfAborted();
    };
    await assert.rejects(
      service.replace('session', operation.id, undefined, controller.signal),
      error => error.name === 'AbortError',
    );
    assert.equal(entered, stage === 'during preflight');
    assert.equal(service.get(operation.id), undefined);
    assert.deepEqual((await storage.get()).operations, []);
  });
}

test('cancellation after checkpoint persistence retains the archive and uncertain next step', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const operation = await service.prepare(cardFixture(), {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
  });
  const controller = new AbortController();
  replacement = async (_session, options) => {
    await options.onCheckpoint('remove-monoid-instance');
    controller.abort();
    options.signal.throwIfAborted();
  };
  await assert.rejects(
    service.replace('session', operation.id, undefined, controller.signal),
    error => error.name === 'AbortError',
  );
  const restarted = await CardMaintenanceService.create(storage);
  assert.equal(restarted.get(operation.id).phase, 'replacing');
  assert.equal(
    restarted.get(operation.id).checkpoint,
    'remove-monoid-instance',
  );
  assert.deepEqual(restarted.get(operation.id).archive, operation.archive);
});

test('a failed checkpoint save cannot authorize deletion and discards the untouched fresh preparation', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const operation = await service.prepareFresh(information, hello);
  const set = storage.set;
  let writes = 0;
  storage.set = async function (...args) {
    if (++writes === 1) throw new Error('Checkpoint not saved');
    return set.apply(this, args);
  };
  let authorized = false;
  replacement = async (_session, options) => {
    await options.onCheckpoint('remove-monoid-instance');
    authorized = true;
  };
  await assert.rejects(
    service.replace('session', operation.id),
    /Checkpoint not saved/,
  );
  assert.equal(authorized, false);
  assert.equal(service.get(operation.id), undefined);
  assert.deepEqual((await storage.get()).operations, []);
});

test('cancellation while saving a preparation removes its acknowledged ready record', async () => {
  for (const mode of ['update', 'fresh']) {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
    const controller = new AbortController();
    storage.afterSet = async () => controller.abort();
    await assert.rejects(
      mode === 'fresh'
        ? service.prepareFresh(information, hello, controller.signal)
        : service.prepare(cardFixture(), {
            mode,
            cardInformation: information,
            appletAid: hex(aid),
            signal: controller.signal,
          }),
      error => error.name === 'AbortError',
    );
    assert.equal(service.operations.length, 0);
    assert.deepEqual((await storage.get()).operations, []);
  }
});

test('a concurrent rejected replace does not clear the operation owned by the active call', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const operation = await service.prepareFresh(information, hello);
  let entered;
  const started = new Promise(resolve => {
    entered = resolve;
  });
  let release;
  const wait = new Promise(resolve => {
    release = resolve;
  });
  replacement = async (_session, options) => {
    entered();
    await wait;
    await options.onCheckpoint('remove-monoid-instance');
    throw new Error('Tag lost');
  };
  const active = service.replace('session', operation.id);
  const result = assert.rejects(active, /Tag lost/);
  await started;
  await assert.rejects(
    service.replace('other-session', operation.id),
    /already running/,
  );
  assert.equal(service.get(operation.id).phase, 'ready');
  release();
  await result;
  assert.equal(service.get(operation.id).checkpoint, 'remove-monoid-instance');
});

test('loading discards untouched records and retains started setup, recovery data and installations', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const operation = await service.prepare(cardFixture(), {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  await service.recordInstallation(hello, {
    identity: true,
    library: true,
    monoid: true,
  });
  storage.mutate(state => {
    const template = state.operations[0];
    template.restored = 2;
    const withoutArchive = {...template};
    delete withoutArchive.archive;
    state.operations = [
      {
        ...template,
        id: 'unstarted',
        archive: {items: [], checksum: 'invalid-unused'},
        grants: ['invalid-unused'],
        grantsChecksum: '',
      },
      {...template, id: 'checkpoint', checkpoint: 'remove-monoid-instance'},
      {
        ...template,
        id: 'replacing',
        phase: 'replacing',
        checkpoint: 'remove-monoid-package',
      },
      {...template, id: 'restore', phase: 'restore'},
      {
        ...withoutArchive,
        id: 'setup',
        mode: 'fresh',
        phase: 'setup',
      },
    ];
  });
  const before = await storage.get();
  const restarted = await CardMaintenanceService.create(storage);
  assert.deepEqual(
    restarted.operations.map(item => item.id),
    ['checkpoint', 'replacing', 'restore', 'setup'],
  );
  assert.deepEqual(await storage.get(), {
    ...before,
    operations: before.operations
      .filter(item => item.id !== 'unstarted')
      .map(({restored: _restored, ...item}) => item),
  });
  assert.deepEqual(restarted.get('restore').archive, operation.archive);
  const writes = storage.writes.length;
  await CardMaintenanceService.create(storage);
  assert.equal(storage.writes.length, writes);
});

test('an obsolete setup record with recovery data is rejected without deleting that data', async () => {
  for (const retained of ['archive', 'grants']) {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
    const card = cardFixture();
    card.grants = [
      {
        aid: bytes('a0000006472f0001'),
        types: [[-3839, true]],
        tokenHash: new Uint8Array(32),
      },
    ];
    await service.prepare(card, {
      mode: 'update',
      cardInformation: information,
      appletAid: hex(aid),
    });
    storage.mutate(state => {
      const operation = state.operations[0];
      operation.mode = 'fresh';
      operation.phase = 'setup';
      if (retained === 'grants') delete operation.archive;
    });
    const before = await storage.get();
    await assert.rejects(
      CardMaintenanceService.create(storage),
      /maintenance data is invalid/,
    );
    assert.deepEqual(await storage.get(), before);
  }
});

test('interrupted replacement resumes the persisted checkpoint after an app restart', async () => {
  const storage = storageFixture();
  let service = await CardMaintenanceService.create(storage);
  const operation = await service.prepare(cardFixture(), {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
  });
  replacement = async (_session, options) => {
    await options.onCheckpoint('remove-monoid-package');
    throw new Error('Tag lost');
  };
  await assert.rejects(service.replace('session', operation.id), /Tag lost/);
  service = await CardMaintenanceService.create(storage);
  replacement = async (_session, options) => {
    assert.equal(options.checkpoint, 'remove-monoid-package');
    assert.equal(options.expectedPublicKey, hex(identity));
    assert.equal(options.expectedFingerprint, 'physical:12345678');
    return structuredClone(hello);
  };
  await service.replace('new-session', operation.id);
  assert.equal(service.get(operation.id).phase, 'restore');
});

test('restore verifies the full Identity, caller AID and unchanged Bundle before import', async () => {
  for (const mismatch of ['id', 'publicKey', 'aid', 'bundle']) {
    const service = await CardMaintenanceService.create(storageFixture());
    const card = cardFixture();
    card.state.alias = 'Daily wallet';
    const operation = await service.prepare(card, {
      mode: 'update',
      cardInformation: information,
      appletAid: hex(aid),
    });
    await service.replace('session', operation.id);
    if (mismatch === 'id') card.state.id = bytes('55667788');
    else if (mismatch === 'publicKey')
      card.state.publicKey = bytes(`04${'22'.repeat(64)}`);
    else if (mismatch === 'aid') card.aid = bytes('f06d6f6e6f69640202');
    else card.state.bundle = new Uint8Array(32);
    await assert.rejects(
      service.restore(card, operation.id),
      mismatch === 'publicKey'
        ? /Card Daily wallet \(01020304\) was reset or reinstalled/
        : mismatch === 'id'
          ? /Wrong card, scan Daily wallet \(01020304\)/
          : /Wrong card|Bundle changed/,
    );
    assert.equal(card.imports.length, 0);
    assert.ok(service.get(operation.id).archive);
  }
});

test('an uncertain Import keeps the archive and explicit retry reads committed items before continuing', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  const operation = await service.prepare(card, {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  await service.replace('session', operation.id);
  const writes = storage.writes.length;
  const progress = [];
  card.failImport = 2;
  await assert.rejects(
    service.restore(card, operation.id, update => progress.push(update)),
    /Tag lost/,
  );
  assert.ok(service.get(operation.id).archive);
  assert.equal('restored' in service.get(operation.id), false);
  assert.equal(storage.writes.length, writes);
  assert.deepEqual(
    progress
      .filter(update => update.stage === 'restore')
      .map(update => update.completed),
    [0, 1],
  );
  card.failImport = -1;
  await service.restore(card, operation.id);
  assert.deepEqual(
    card.imports.map(item => hex(item.index)),
    sourceItems.map(item => hex(item.index)),
  );
  assert.equal(card.imports[0].metadata, undefined);
  assert.deepEqual(card.imports[1].metadata, bytes(''));
  assert.deepEqual(card.imports[2].metadata, bytes('aa'));
  assert.ok(card.imports.every(item => !('key' in item)));
  assert.equal(card.imports[1].alias, '');
  assert.equal(service.get(operation.id), undefined);
  assert.deepEqual((await storage.get()).operations, []);
  assert.equal(storage.writes.length, writes + 1);
});

test('a final list mismatch retains the entire archive even after every Import succeeds', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  const operation = await service.prepare(card, {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  await service.replace('session', operation.id);
  card.mismatchList = true;
  const progress = [];
  await assert.rejects(
    service.restore(card, operation.id, update => progress.push(update)),
    /does not match/,
  );
  assert.deepEqual(progress.at(-1), {stage: 'verifying-restore'});
  assert.equal(service.get(operation.id).archive.items.length, 3);
  assert.equal(service.get(operation.id).phase, 'restore');
});

test('archive corruption prevents loading saved recovery data', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const operation = await service.prepare(cardFixture(), {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  await service.replace('session', operation.id);
  storage.mutate(state => {
    state.operations[0].archive.items[0].data = '00';
  });
  await assert.rejects(CardMaintenanceService.create(storage), /integrity/);
});

test('Bundle maintenance stays an unpersisted draft until a peer recovery archive is saved', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(9);
  const operation = await service.prepare(card, {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
  });
  assert.equal(operation.archive, undefined);
  assert.equal(card.listCalls.length, 0);
  assert.equal(card.exports.length, 0);
  assert.equal(storage.writes.length, 0);
  let replacements = 0;
  replacement = async () => {
    replacements++;
    return structuredClone(card.state);
  };
  await assert.rejects(service.replace('session', operation.id), /not found/);
  assert.equal(replacements, 0);
  assert.equal(
    (await CardMaintenanceService.create(storage)).operations.length,
    0,
  );
});

test('discarding one card preparation does not remove another card recovery archive', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const first = await service.prepare(cardFixture(), {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  await service.replace('first-session', first.id);
  const original = structuredClone(await storage.get());
  const other = cardFixture();
  other.state.publicKey = bytes(`04${'22'.repeat(64)}`);
  other.state.id = bytes('11223344');
  const next = await service.prepare(other, {
    mode: 'reinstall',
    cardInformation: {...information, cplc: {icSerialNumber: '87654321'}},
    appletAid: hex(aid),
  });
  replacement = async () => {
    throw new Error('Preflight failed');
  };
  await assert.rejects(
    service.replace('other-session', next.id),
    /Preflight failed/,
  );
  assert.deepEqual(await storage.get(), original);
  assert.deepEqual(service.get(first.id).archive, first.archive);
});

for (const fromRecord of [false, true]) {
  test(`Fresh retains the exact alias from ${fromRecord ? 'previous maintenance' : 'Hello'} until verified after installation`, async () => {
    const storage = storageFixture();
    let service = await CardMaintenanceService.create(storage);
    const card = cardFixture();
    card.state.alias = ' 旅行卡 😀 ';
    if (fromRecord)
      await service.prepare(card, {
        mode: 'reinstall',
        cardInformation: information,
        appletAid: hex(aid),
      });
    const operation = await service.prepareFresh(
      information,
      fromRecord ? undefined : card.state,
    );
    assert.equal(operation.card.alias, card.state.alias);
    assert.equal(operation.card.id, hex(card.state.id));
    await service.replace('session', operation.id);
    assert.equal(
      service.get(operation.id).card.alias,
      card.state.alias,
      'replacement does not discard the alias',
    );
    service = await CardMaintenanceService.create(storage);
    assert.equal(service.get(operation.id).card.alias, card.state.alias);
    await assert.rejects(
      service.finishFreshAlias(operation.id, {...card.state, alias: false}),
      /verify.*alias/,
    );
    assert.ok(service.get(operation.id));
    await service.finishFreshAlias(operation.id, card.state);
    assert.equal(service.get(operation.id), undefined);
  });
}

test('fresh reinstall without Hello retains its generated Card ID through setup and clears only its own completed operation', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const first = await service.prepareFresh(information);
  const second = await service.prepareFresh({
    ...information,
    cplc: {icSerialNumber: '87654321'},
  });
  replacement = async (_session, options) => {
    assert.equal(options.fresh, true);
    await options.onCheckpoint('verify');
    return structuredClone(hello);
  };
  assert.equal(
    service.matchOperation({cardInformation: information, appletAid: hex(aid)})
      .id,
    first.id,
  );
  await service.replace('session', first.id);
  assert.equal(service.get(first.id).card.id, hex(hello.id));
  await assert.rejects(
    service.finishFreshAlias(first.id, {
      ...hello,
      pins: {access: false, secret: 5},
    }),
    /verify/,
  );
  await service.finishFreshAlias(first.id, hello);
  assert.equal(service.get(first.id), undefined);
  assert.equal(service.operations.length, 1);
  assert.equal(service.operations[0].id, second.id);
});

test('Fresh retains the original Card ID and chosen Authority across interrupted replacement', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const options = {
    authorityUrl: 'https://chosen-authority.example/api',
    authorityPublicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(7)),
  };
  const operation = await service.prepareFresh(
    information,
    hello,
    undefined,
    [],
    options,
  );
  replacement = async (_session, actual) => {
    assert.equal(actual.expectedCardId, hex(hello.id));
    assert.equal(actual.authorityUrl, options.authorityUrl);
    assert.deepEqual(actual.authorityPublicKey, options.authorityPublicKey);
    await actual.onCheckpoint('remove-monoid-instance');
    throw new Error('Tag lost');
  };
  await assert.rejects(service.replace('session', operation.id), /Tag lost/);
  const resumed = await CardMaintenanceService.create(storage);
  replacement = async (_session, actual) => {
    assert.equal(actual.expectedCardId, hex(hello.id));
    assert.equal(actual.authorityUrl, options.authorityUrl);
    assert.deepEqual(actual.authorityPublicKey, options.authorityPublicKey);
    assert.equal(actual.checkpoint, 'remove-monoid-instance');
    return structuredClone(hello);
  };
  await resumed.replace('session', operation.id);
});

test('Fresh rejects incomplete Authority settings instead of silently omitting them', async () => {
  const service = await CardMaintenanceService.create(storageFixture());
  await assert.rejects(
    service.prepareFresh(information, undefined, undefined, [], {
      authorityUrl: 'https://authority.example',
    }),
    /required together/,
  );
  assert.equal(service.operations.length, 0);
});

for (const failure of ['installation record', 'operation removal']) {
  test(`Fresh ${failure} failure preserves the verify checkpoint for a non-destructive retry`, async () => {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
    const operation = await service.prepareFresh(information, hello);
    const set = storage.set;
    storage.set = async function (key, value) {
      if (
        value.installations?.length &&
        (failure === 'installation record' || value.operations.length === 0)
      ) {
        throw new Error('Storage interrupted');
      }
      return set.call(this, key, value);
    };
    await assert.rejects(async () => {
      const next = await service.replace('session', operation.id);
      await service.finishFreshAlias(operation.id, next);
    }, /Storage interrupted/);
    assert.equal(service.get(operation.id).phase, 'replacing');
    assert.equal(service.get(operation.id).checkpoint, 'verify');
    assert.equal((await storage.get()).operations[0].checkpoint, 'verify');
    storage.set = set;
    replacement = async (_session, options) => {
      assert.equal(options.checkpoint, 'verify');
      return structuredClone(hello);
    };
    const next = await service.replace('retry-session', operation.id);
    await service.finishFreshAlias(operation.id, next);
    assert.equal(service.get(operation.id), undefined);
    assert.equal(service.isUpdateAvailable(hello), false);
    assert.equal(service.isIdentityUpdateAvailable(hello), false);
  });
}

test('a new ordinary operation cannot overwrite an existing archive while Fresh preserves it', async () => {
  const service = await CardMaintenanceService.create(storageFixture());
  const original = await service.prepare(cardFixture(), {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  await assert.rejects(
    service.prepare(cardFixture(), {
      mode: 'reinstall',
      cardInformation: information,
      appletAid: hex(aid),
    }),
    /existing card maintenance/,
  );
  const fresh = await service.prepareFresh(information);
  assert.notEqual(fresh.id, original.id);
  assert.equal(service.get(original.id).archive.items.length, 3);
});

test('Fresh retains its new Identity setup until completion without removing another recovery archive', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const original = await service.prepare(cardFixture(), {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  await service.replace('session', original.id);
  const fresh = await service.prepareFresh(information, hello);
  const newHello = {
    ...structuredClone(hello),
    publicKey: bytes(`04${'33'.repeat(64)}`),
  };
  replacement = async (_session, options) => {
    await options.onCheckpoint('verify');
    return newHello;
  };
  assert.deepEqual(await service.replace('session', fresh.id), newHello);
  assert.equal(service.get(fresh.id).checkpoint, 'verify');
  await service.finishFreshAlias(fresh.id, newHello);
  assert.equal(service.get(fresh.id), undefined);
  assert.equal(
    service.matchOperation({hello: newHello, cardInformation: information}),
    undefined,
  );
  assert.ok(service.get(original.id).archive);
  const restarted = await CardMaintenanceService.create(storage);
  assert.equal(
    restarted.matchOperation({hello: newHello, cardInformation: information}),
    undefined,
  );
  assert.ok(restarted.get(original.id).archive);
  assert.equal(restarted.isIdentityUpdateAvailable(newHello), false);
  assert.equal(restarted.isUpdateAvailable(newHello), false);
  const newCard = cardFixture();
  newCard.state = newHello;
  await service.prepare(newCard, {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
});

test('installation bookkeeping names each component and leaves retained or unknown packages unchanged', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  assert.equal(service.isUpdateAvailable(hello), undefined);
  await service.recordInstallation(hello, {monoid: true});
  assert.equal(service.isUpdateAvailable(hello), undefined);
  assert.equal(service.isIdentityUpdateAvailable(hello), undefined);
  assert.deepEqual((await storage.get()).installations, [
    {
      publicKey: hex(hello.publicKey),
      appletAid: hex(aid),
      monoidHash: 'monoid-image',
    },
  ]);
  await service.recordInstallation(hello, {library: true});
  assert.equal(service.isUpdateAvailable(hello), false);
  assert.equal(service.isIdentityUpdateAvailable(hello), undefined);
  bundleHashes[1] = 'new-library-image';
  assert.equal(service.isUpdateAvailable(hello), true);
  await service.recordInstallation(hello, {monoid: true});
  assert.equal(service.isUpdateAvailable(hello), true);
  assert.equal(
    (await storage.get()).installations[0].libraryHash,
    'library-image',
  );
  await service.recordInstallation(hello, {library: true});
  assert.equal(service.isUpdateAvailable(hello), false);
  bundleHashes[2] = 'new-monoid-image';
  assert.equal(service.isUpdateAvailable(hello), true);
});

test('a known outdated component shows an update even when the other component is unknown', async () => {
  for (const [stage, index] of [
    ['monoid', 2],
    ['library', 1],
  ]) {
    const service = await CardMaintenanceService.create(storageFixture());
    await service.recordInstallation(hello, {[stage]: true});
    assert.equal(service.isUpdateAvailable(hello), undefined);
    const oldHash = bundleHashes[index];
    bundleHashes[index] = `new-${stage}-image`;
    assert.equal(service.isUpdateAvailable(hello), true);
    bundleHashes[index] = oldHash;
  }
});

test('successful replacement records Library and Monoid without relabeling retained Identity', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  await service.recordInstallation(hello, {identity: true});
  bundleHashes[0] = 'new-identity-image';
  const operation = await service.prepare(cardFixture(), {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  await service.replace('session', operation.id);
  assert.equal(service.isUpdateAvailable(hello), false);
  assert.equal(service.isIdentityUpdateAvailable(hello), true);
  assert.deepEqual((await storage.get()).installations, [
    {
      publicKey: hex(hello.publicKey),
      appletAid: hex(aid),
      identityHash: 'identity-image',
      libraryHash: 'library-image',
      monoidHash: 'monoid-image',
    },
  ]);
});

test('Fresh replacement records all three installed component hashes', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const operation = await service.prepareFresh(information, hello);
  await service.replace('session', operation.id);
  assert.equal(service.isUpdateAvailable(hello), false);
  assert.equal(service.isIdentityUpdateAvailable(hello), false);
  assert.deepEqual((await storage.get()).installations, [
    {
      publicKey: hex(hello.publicKey),
      appletAid: hex(aid),
      identityHash: 'identity-image',
      libraryHash: 'library-image',
      monoidHash: 'monoid-image',
    },
  ]);
});

test('peer recovery is canonical, durable before deletion and restores v2 envelopes without a sender parameter', async () => {
  const storage = storageFixture();
  let service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(0xab);
  const draft = await service.prepare(card, {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  const recovery = bundleRecovery(card);
  recovery.source.bundle = recovery.source.bundle.toUpperCase();
  recovery.items.reverse();
  for (const item of recovery.items) {
    item.index = item.index.toUpperCase();
    item.data = item.data.toUpperCase();
    if (item.key) item.key = item.key.toUpperCase();
  }
  const saved = await service.saveBundleRecovery(draft, recovery);
  assert.equal(saved.phase, 'ready');
  assert.equal(saved.archive.source.bundle, hex(card.state.bundle));
  assert.deepEqual(
    saved.archive.items.map(item => item.index),
    sourceItems.map(item => hex(item.index)),
  );
  assert.equal(saved.archive.items[0].key, undefined);
  assert.equal(saved.archive.items[1].key, '');
  assert.equal(saved.archive.items[1].alias, '');
  service = await CardMaintenanceService.create(storage);
  assert.deepEqual(service.get(saved.id), saved);
  replacement = async (_session, options) => {
    assert.equal(
      (await storage.get()).operations[0].archive.checksum,
      saved.archive.checksum,
    );
    await options.onCheckpoint('remove-monoid-instance');
    return structuredClone(card.state);
  };
  await service.replace('session', saved.id);
  service = await CardMaintenanceService.create(storage);
  assert.equal(service.get(saved.id).phase, 'restore');
  await service.restore(card, saved.id);
  assert.equal(card.imports.length, 3);
  assert.equal(
    card.imports.every(request => !('senderPublicKey' in request)),
    true,
  );
  assert.equal(service.get(saved.id), undefined);
});

for (const [name, mutate] of [
  [
    'same full Identity',
    (recovery, card) => (recovery.source.publicKey = hex(card.state.publicKey)),
  ],
  ['different Bundle', recovery => (recovery.source.bundle = 'cd'.repeat(32))],
  ['malformed source ID', recovery => (recovery.source.id = '112233zz')],
  [
    'malformed source public key',
    recovery => (recovery.source.publicKey = `05${'22'.repeat(64)}`),
  ],
  [
    'invalid hexadecimal item data',
    recovery => (recovery.items[0].data += 'gg'),
  ],
  ['odd hexadecimal metadata', recovery => (recovery.items[0].key = 'a')],
  ['invalid index length', recovery => (recovery.items[0].index = '01')],
  [
    'duplicate index',
    recovery =>
      recovery.items.push({
        ...recovery.items[2],
        index: recovery.items[2].index.toUpperCase(),
      }),
  ],
  ['invalid secret flag', recovery => (recovery.items[0].secret = 1)],
  ['invalid alias', recovery => (recovery.items[0].alias = null)],
  [
    'v1 envelope',
    recovery =>
      (recovery.items[0].data = `01${recovery.items[0].data.slice(2)}`),
  ],
  [
    'truncated v2 envelope',
    recovery => (recovery.items[0].data = recovery.items[0].data.slice(0, -2)),
  ],
  [
    'wrong embedded Bundle',
    recovery =>
      (recovery.items[0].data = `02${'ee'.repeat(32)}${recovery.items[0].data.slice(66)}`),
  ],
  [
    'wrong embedded sender',
    recovery =>
      (recovery.items[0].data = `${recovery.items[0].data.slice(
        0,
        66,
      )}04${'ee'.repeat(64)}${recovery.items[0].data.slice(196)}`),
  ],
  [
    'oversized Import request',
    recovery => (recovery.items[0].data += '00'.repeat(8192)),
  ],
]) {
  test(`peer recovery rejects ${name} before storing or replacing anything`, async () => {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
    const card = cardFixture();
    card.state.bundle = new Uint8Array(32).fill(9);
    const draft = await service.prepare(card, {
      mode: 'update',
      cardInformation: information,
      appletAid: hex(aid),
    });
    const recovery = bundleRecovery(card);
    mutate(recovery, card);
    await assert.rejects(service.saveBundleRecovery(draft, recovery));
    assert.equal(storage.writes.length, 0);
    assert.equal(service.operations.length, 0);
    assert.deepEqual(card.imports, []);
  });
}

test('peer identity uses the full public key even when short card IDs coincide', () => {
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(9);
  const recovery = bundleRecovery(card);
  recovery.source.id = hex(card.state.id);
  assert.doesNotThrow(() =>
    assertCardMaintenanceBundleRecovery(
      {publicKey: hex(card.state.publicKey), bundle: hex(card.state.bundle)},
      recovery,
    ),
  );
});

for (const failure of ['write', 'readback']) {
  test(`a peer archive ${failure} failure never authorizes replacement`, async () => {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
    const card = cardFixture();
    card.state.bundle = new Uint8Array(32).fill(9);
    const draft = await service.prepare(card, {
      mode: 'update',
      cardInformation: information,
      appletAid: hex(aid),
    });
    if (failure === 'write') storage.failWrite = true;
    else storage.corruptRead = true;
    await assert.rejects(
      service.saveBundleRecovery(draft, bundleRecovery(card)),
      /Disk full|verify/,
    );
    let replacements = 0;
    replacement = async () => {
      replacements++;
      return card.state;
    };
    await assert.rejects(service.replace('session', draft.id), /not found/);
    assert.equal(replacements, 0);
    assert.equal(service.operations.length, 0);
    storage.failWrite = false;
    storage.corruptRead = false;
    assert.equal(
      (await CardMaintenanceService.create(storage)).operations.length,
      0,
    );
  });
}

test('peer archive source metadata is bound to the checksum on restart', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(9);
  const draft = await service.prepare(card, {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  await service.saveBundleRecovery(draft, bundleRecovery(card));
  storage.mutate(state => (state.operations[0].archive.source.id = 'aabbccdd'));
  await assert.rejects(CardMaintenanceService.create(storage), /integrity/);
});

for (const phase of ['ready', 'replacing', 'restore']) {
  test(`a saved ${phase} peer archive cannot be overwritten`, async () => {
    const storage = storageFixture();
    let service = await CardMaintenanceService.create(storage);
    const card = cardFixture();
    card.state.bundle = new Uint8Array(32).fill(9);
    const draft = await service.prepare(card, {
      mode: 'update',
      cardInformation: information,
      appletAid: hex(aid),
    });
    await service.saveBundleRecovery(draft, bundleRecovery(card));
    storage.mutate(state => {
      state.operations[0].phase = phase;
      if (phase === 'replacing') state.operations[0].checkpoint = 'verify';
    });
    service = await CardMaintenanceService.create(storage);
    const previous = structuredClone(await storage.get());
    await assert.rejects(
      service.saveBundleRecovery(draft, bundleRecovery(card)),
      /cannot be replaced/,
    );
    await assert.rejects(
      service.saveBundleRecovery(
        {...draft, id: 'another-task'},
        bundleRecovery(card),
      ),
      /existing card maintenance/,
    );
    assert.deepEqual(await storage.get(), previous);
  });
}

test('peer archive preflight failure preserves the durable recovery checkpoint', async () => {
  const storage = storageFixture();
  let service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(9);
  const draft = await service.prepare(card, {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  const saved = await service.saveBundleRecovery(draft, bundleRecovery(card));
  bundleHashes[2] = 'changed-image';
  replacement = async () => {
    throw new Error('Must not replace');
  };
  await assert.rejects(service.replace('session', saved.id), /package changed/);
  assert.equal(service.get(saved.id).phase, 'ready');
  service = await CardMaintenanceService.create(storage);
  assert.deepEqual(service.get(saved.id).archive, saved.archive);
});

test('even a legacy started Bundle replacement cannot delete Monoid without an archive', async () => {
  const storage = storageFixture();
  let service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(9);
  const draft = await service.prepare(card, {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  await storage.set('cardMaintenance', {
    version: 1,
    operations: [{...draft, phase: 'replacing', checkpoint: 'verify'}],
  });
  service = await CardMaintenanceService.create(storage);
  replacement = async () => {
    throw new Error('Must not replace');
  };
  await assert.rejects(
    service.replace('session', draft.id),
    /archive is missing/,
  );
});

test('all restored items and their manifest are verified before any applet grant is restored', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(9);
  card.grants = [
    {
      aid: bytes('a0000006472f0001'),
      seed: {index: sourceItems[0].index, domain: bytes('aabb')},
    },
  ];
  const draft = await service.prepare(card, {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  const operation = await service.saveBundleRecovery(
    draft,
    bundleRecovery(card),
  );
  replacement = async () => structuredClone(card.state);
  await service.replace('session', operation.id);
  card.grants = [];
  const events = [];
  const importItem = card.importItem;
  card.importItem = async function (request) {
    await importItem.call(this, request);
    events.push('item');
  };
  const list = card.list;
  card.list = async function (request) {
    events.push('list');
    return list.call(this, request);
  };
  const setGrant = card.setAppletGrant;
  card.setAppletGrant = async function (request) {
    events.push('grant');
    return setGrant.call(this, request);
  };
  await service.restore(card, operation.id, undefined, undefined, [
    'a0000006472f0001',
  ]);
  assert.deepEqual(events, ['item', 'item', 'item', 'list', 'grant']);
});

for (const secret of [true, false]) {
  test(`HMAC authorization restores the exact ${secret ? 'protected' : 'readable'} key without requesting its public key`, async () => {
    const service = await CardMaintenanceService.create(storageFixture());
    const card = cardFixture();
    const index = bytes('05140000000000000001');
    const otpAid = bytes('f06d6f6e6f69640501');
    card.items.push({index, secret});
    card.grants = [
      {aid: otpAid, types: [[-3583, false]], keys: [{index, type: 'hmac'}]},
    ];
    const operation = await service.prepare(card, {
      mode: 'update',
      cardInformation: information,
      appletAid: hex(aid),
    });
    await service.replace('session', operation.id);
    card.grants = [];
    card.viewKey = () => assert.fail('HMAC has no public key');
    await service.restore(card, operation.id, undefined, undefined, [
      hex(otpAid),
    ]);
    assert.deepEqual(card.grants[0].keys, [{index, type: 'hmac'}]);
    assert.equal(card.items.at(-1).secret, secret);
    assert.equal(service.get(operation.id), undefined);
  });
}

test('a restored HMAC key with a changed secret flag prevents authorization and retains recovery', async () => {
  const service = await CardMaintenanceService.create(storageFixture());
  const card = cardFixture();
  const index = bytes('05140000000000000001');
  card.items.push({index, secret: true});
  card.grants = [
    {aid: bytes('f06d6f6e6f69640501'), keys: [{index, type: 'hmac'}]},
  ];
  const operation = await service.prepare(card, {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  await service.replace('session', operation.id);
  card.items.at(-1).secret = false;
  card.setAppletGrant = () =>
    assert.fail('Restore must verify protection first');
  await assert.rejects(service.restore(card, operation.id), /does not match/);
  assert(service.get(operation.id).archive);
});

for (const index of ['02400000000000000001', '05000000000000000001']) {
  test(`an invalid HMAC grant source ${index.slice(0, 4)} stops before any authorization is restored`, async () => {
    const service = await CardMaintenanceService.create(storageFixture());
    const card = cardFixture();
    const otpAid = bytes('f06d6f6e6f69640501');
    if (!card.items.some(item => hex(item.index) === index))
      card.items.push({index: bytes(index), secret: true});
    card.grants = [
      {aid: bytes('a0000006472f0001'), types: [[-3839, true]]},
      {aid: otpAid, keys: [{index: bytes(index), type: 'hmac'}]},
    ];
    const operation = await service.prepare(card, {
      mode: 'update',
      cardInformation: information,
      appletAid: hex(aid),
    });
    await service.replace('session', operation.id);
    card.grants = [];
    card.setAppletGrant = () =>
      assert.fail('Invalid grants must be preflighted');
    await assert.rejects(
      service.restore(card, operation.id),
      /Invalid HMAC key/,
    );
    assert(service.get(operation.id).archive);
  });
}

for (const missing of ['seed', 'key', 'applet']) {
  test(`preflighting every grant prevents all authorization writes when a later ${missing} is missing`, async () => {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
    const card = cardFixture();
    const firstAid = 'a0000006472f0001';
    const secondAid = 'a0000006472f0002';
    card.grants = [
      {aid: bytes(firstAid), types: [[-3839, true]]},
      {
        aid: bytes(secondAid),
        ...(missing === 'seed'
          ? {
              seed: {
                index: bytes('02400000000000000099'),
                domain: bytes('aabb'),
              },
            }
          : missing === 'key'
            ? {
                keys: [
                  {index: bytes('02200000000000000099'), type: 'secp256r1'},
                ],
              }
            : {types: [[-3839, true]]}),
      },
    ];
    const operation = await service.prepare(card, {
      mode: 'update',
      cardInformation: information,
      appletAid: hex(aid),
    });
    await service.replace('session', operation.id);
    card.grants = [];
    let writes = 0;
    card.setAppletGrant = async () => {
      writes++;
    };
    await assert.rejects(
      service.restore(
        card,
        operation.id,
        undefined,
        undefined,
        missing === 'applet' ? [firstAid] : [firstAid, secondAid],
      ),
      missing === 'applet'
        ? /Install the required applet/
        : /Restore applet keys/,
    );
    assert.equal(writes, 0);
    assert.equal(card.imports.length, sourceItems.length);
    assert.equal(
      service.get(operation.id).archive.items.length,
      sourceItems.length,
    );
  });
}

for (const missing of ['seed', 'key']) {
  test(`a peer missing a grant's ${missing} is rejected before saving and another peer can be chosen`, async () => {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
    const card = cardFixture();
    card.state.bundle = new Uint8Array(32).fill(9);
    const index =
      missing === 'seed' ? sourceItems[0].index : bytes('02200000000000000011');
    if (missing === 'key') card.items.push({index, secret: true});
    card.grants = [
      {
        aid: bytes('a0000006472f0001'),
        ...(missing === 'seed'
          ? {seed: {index, domain: bytes('aabb')}}
          : {keys: [{index, type: 'secp256r1'}]}),
      },
    ];
    const draft = await service.prepare(card, {
      mode: 'update',
      cardInformation: information,
      appletAid: hex(aid),
    });
    const previous = structuredClone(await storage.get());
    const missingDependency = bundleRecovery(card);
    missingDependency.items = missingDependency.items.filter(
      item => item.index !== hex(index),
    );
    await assert.rejects(
      service.saveBundleRecovery(draft, missingDependency),
      /Restore applet keys first/,
    );
    assert.deepEqual(await storage.get(), previous);
    assert.equal(service.get(draft.id), undefined);
    const saved = await service.saveBundleRecovery(draft, bundleRecovery(card));
    assert.equal(saved.phase, 'ready');
    assert.deepEqual(saved.grants, draft.grants);
  });
}

test('an unstarted Bundle draft requires its saved grant sources in the peer archive', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(9);
  card.grants = [
    {
      aid: bytes('a0000006472f0001'),
      seed: {index: sourceItems[0].index, domain: bytes('aabb')},
    },
  ];
  const draft = await service.prepare(card, {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  const recovery = bundleRecovery(card);
  recovery.items.shift();
  await assert.rejects(
    service.saveBundleRecovery(draft, recovery),
    /Restore applet keys first/,
  );
  assert.equal(storage.writes.length, 0);
  assert.equal(service.operations.length, 0);
});

test('discarding an unstarted peer recovery archive is durable and allows collecting a new preparation', async () => {
  const storage = storageFixture();
  let service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(9);
  const options = {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
  };
  const draft = await service.prepare(card, options);
  const original = await service.saveBundleRecovery(
    draft,
    bundleRecovery(card),
  );
  assert.equal(original.phase, 'ready');
  assert.equal(original.checkpoint, undefined);
  replacement = async () => {
    throw new Error('Must not touch the card');
  };
  service.holdSecretPIN(original.card, 'Secret-42');
  await service.discardPrepared(original.id);
  assert.equal(service.secretPIN(original.card), undefined);
  assert.equal(service.get(original.id), undefined);
  assert.deepEqual((await storage.get()).operations, []);
  service = await CardMaintenanceService.create(storage);
  assert.equal(service.get(original.id), undefined);
  const next = await service.prepare(card, options);
  assert.notEqual(next.id, original.id);
  assert.equal(next.archive, undefined);
  assert.equal(service.operations.length, 0);
  assert.deepEqual(card.imports, []);
  assert.deepEqual(card.exports, []);
});

test('discarding a missing preparation is idempotent and does not write storage', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  await service.discardPrepared('missing-operation');
  assert.equal(storage.writes.length, 0);
  const card = cardFixture();
  const operation = await service.prepare(card, {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
  });
  await service.discardPrepared(operation.id);
  const writes = storage.writes.length;
  await service.discardPrepared(operation.id);
  assert.equal(storage.writes.length, writes);
  const next = await service.prepare(card, {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
  });
  assert.notEqual(next.id, operation.id);
});

for (const mode of ['fresh', 'update', 'reinstall']) {
  test(`Start over discards an untouched ${mode} plan durably`, async () => {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
    const prepare = () =>
      mode === 'fresh'
        ? service.prepareFresh(information, hello)
        : service.prepare(cardFixture(), {
            mode,
            cardInformation: information,
            appletAid: hex(aid),
          });
    const operation = await prepare();
    await service.discardPrepared(operation.id);
    assert.equal(service.get(operation.id), undefined);
    assert.deepEqual((await storage.get()).operations, []);
    const next = await prepare();
    assert.equal(await service.restart(next.id), undefined);
    assert.deepEqual((await storage.get()).operations, []);
    assert.deepEqual(
      (await CardMaintenanceService.create(storage)).operations,
      [],
    );
  });
}

for (const mode of ['update', 'reinstall']) {
  for (const peer of [false, true]) {
    for (const [phase, checkpoint] of [
      ['ready', 'remove-monoid-instance'],
      ['replacing', undefined],
      ['replacing', 'install'],
      ['restore', 'verify'],
      ['setup', undefined],
    ]) {
      test(`Start over restarts ${mode} ${phase}/${checkpoint} with ${peer ? 'peer' : 'own'} recovery byte-identical and restores it after replacement`, async () => {
        const storage = storageFixture();
        let service = await CardMaintenanceService.create(storage);
        const card = cardFixture();
        if (peer) card.state.bundle = new Uint8Array(32).fill(9);
        card.grants = [
          {
            aid: bytes('a0000006472f0001'),
            types: [[-3839, true]],
            tokenHash: new Uint8Array(32),
          },
        ];
        const prepared = await service.prepare(card, {
          mode,
          cardInformation: information,
          appletAid: hex(aid),
          selectedOptionalStages: ['security-key'],
        });
        if (peer)
          await service.saveBundleRecovery(prepared, bundleRecovery(card));
        storage.mutate(state => {
          Object.assign(state.operations[0], {
            phase,
            checkpoint,
            rejectedItems: [{index: '01', reason: 'Previous rejection'}],
          });
        });
        service = await CardMaintenanceService.create(storage);
        const original = (await storage.get()).operations.find(
          operation => operation.id === prepared.id,
        );
        const recoveryBytes = operation =>
          Buffer.from(
            JSON.stringify({
              archive: operation.archive,
              grants: operation.grants,
              grantsChecksum: operation.grantsChecksum,
              previousGrantTokens: operation.previousGrantTokens,
              previousGrantTokensChecksum:
                operation.previousGrantTokensChecksum,
            }),
          );
        const archive = recoveryBytes(original);
        service.holdSecretPIN(original.card, 'Secret-42');
        bundleHashes[2] = 'current-monoid-image';
        const reset = await service.restart(prepared.id);
        assert.equal(reset.id, original.id);
        assert.equal(reset.createdAt, original.createdAt);
        assert.equal(reset.mode, mode);
        assert.equal(reset.phase, 'ready');
        assert.equal(reset.restarted, true);
        assert.equal(reset.checkpoint, undefined);
        assert.equal(reset.rejectedItems, undefined);
        assert.deepEqual(reset.card, original.card);
        assert.deepEqual(reset.selectedOptionalStages, ['security-key']);
        assert.deepEqual(reset.bundleHashes, bundleHashes);
        assert.deepEqual(recoveryBytes(reset), archive);
        assert.equal(service.secretPIN(original.card), 'Secret-42');
        await assert.rejects(
          service.discardPrepared(reset.id),
          /already started/,
        );

        service = await CardMaintenanceService.create(storage);
        assert.deepEqual(recoveryBytes(service.get(reset.id)), archive);
        assert.equal(
          service.matchOperation({cardInformation: information}).id,
          reset.id,
        );
        const changedIdentity = {
          ...card.state,
          publicKey: bytes(`04${'99'.repeat(64)}`),
        };
        assert.equal(
          service.matchOperation({
            hello: changedIdentity,
            cardInformation: information,
          }),
          undefined,
          'a restarted retained Identity cannot be rebound by its chip fingerprint',
        );
        replacement = async () => {
          throw new Error('Preflight failed');
        };
        await assert.rejects(
          service.replace('session', reset.id),
          /Preflight failed/,
        );
        await assert.rejects(
          service.discardPrepared(reset.id),
          /already started/,
        );
        service = await CardMaintenanceService.create(storage);
        await service.restart(reset.id);
        assert.deepEqual(recoveryBytes(service.get(reset.id)), archive);
        replacement = async (_session, options) => {
          assert.equal(options.fresh, false);
          assert.equal(options.restarted, true);
          assert.equal(options.checkpoint, undefined);
          assert.equal(options.expectedPublicKey, original.card.publicKey);
          assert.equal(options.expectedCardId, original.card.id);
          assert.equal(options.expectedBundle, original.card.bundle);
          assert.equal(options.expectedAppletAid, original.card.appletAid);
          await options.onCheckpoint('remove-security-key-instance');
          assert.equal(service.get(reset.id).phase, 'replacing');
          assert.deepEqual(recoveryBytes(service.get(reset.id)), archive);
          await options.onCheckpoint('install');
          await options.onCheckpoint('verify');
          return structuredClone(card.state);
        };
        await service.replace('session', reset.id);
        assert.equal(service.get(reset.id).phase, 'restore');
        assert.deepEqual(recoveryBytes(service.get(reset.id)), archive);
        // Recovery still refuses another Identity after installation.
        card.state = changedIdentity;
        await assert.rejects(
          service.restore(card, reset.id),
          /reset or reinstalled/,
        );
        assert.equal(card.imports.length, 0);
        card.state = {...card.state, publicKey: bytes(original.card.publicKey)};
        card.grants = [];
        assert.equal((await service.restore(card, reset.id)).complete, true);
        assert.equal(card.imports.length, original.archive.items.length);
        assert.equal(card.grants.length, original.grants.length);
        assert.equal(service.get(reset.id), undefined);
      });
    }
  }
}

for (const mode of ['fresh', 'update', 'reinstall']) {
  test(`a restarted ${mode} plan survives preflight failure and reload without becoming discardable`, async () => {
    const storage = storageFixture();
    let service = await CardMaintenanceService.create(storage);
    const operation =
      mode === 'fresh'
        ? await service.prepareFresh(information, hello)
        : await service.prepare(cardFixture(), {
            mode,
            cardInformation: information,
            appletAid: hex(aid),
          });
    await service.replace('session', operation.id);
    await service.restart(operation.id);
    replacement = async () => {
      throw new Error('Before card writes');
    };
    await assert.rejects(
      service.replace('session', operation.id),
      /Before card writes/,
    );
    service = await CardMaintenanceService.create(storage);
    assert.equal(service.get(operation.id).restarted, true);
    await assert.rejects(
      service.discardPrepared(operation.id),
      /already started/,
    );
  });
}

for (const mode of ['update', 'reinstall']) {
  test(`restarting an optional-only ${mode} preserves its grant token comparison without erasing Monoid`, async () => {
    const storage = storageFixture();
    let service = await CardMaintenanceService.create(storage);
    const card = cardFixture();
    card.grants = [
      {
        aid: bytes('a0000006472f0001'),
        types: [[-3839, true]],
        tokenHash: new Uint8Array(32),
      },
    ];
    const operation = await service.prepare(card, {
      mode,
      cardInformation: information,
      appletAid: hex(aid),
      selectedOptionalStages: ['security-key'],
      replaceStages: ['security-key'],
    });
    await service.replace('first-session', operation.id);
    const before = (await storage.get()).operations[0];
    assert.equal(before.archive, undefined);
    await service.restart(operation.id);
    service = await CardMaintenanceService.create(storage);
    const reset = service.get(operation.id);
    assert.equal(reset.archive, undefined);
    assert.deepEqual(reset.grants, before.grants);
    assert.equal(reset.grantsChecksum, before.grantsChecksum);
    assert.deepEqual(reset.previousGrantTokens, before.previousGrantTokens);
    assert.equal(
      reset.previousGrantTokensChecksum,
      before.previousGrantTokensChecksum,
    );
    replacement = async (_session, options) => {
      assert.equal(options.checkpoint, undefined);
      assert.deepEqual(options.replaceStages, ['security-key']);
      assert.deepEqual(options.selectedOptionalStages, ['security-key']);
      await options.onCheckpoint('remove-security-key-instance');
      await options.onCheckpoint('verify');
      return structuredClone(card.state);
    };
    await service.replace('second-session', operation.id);
    assert.equal(service.get(operation.id).phase, 'restore');
    assert.equal((await service.restore(card, operation.id)).complete, true);
    assert.equal(card.imports.length, 0);
    assert.notEqual(hex(card.grants[0].tokenHash), hex(new Uint8Array(32)));
  });
}

for (const checkpoint of [
  undefined,
  'remove-monoid-package',
  'install',
  'verify',
]) {
  test(`Start over resets fresh ${checkpoint ?? 'preparation'} durably while retaining its identity and installation options`, async () => {
    const storage = storageFixture();
    let service = await CardMaintenanceService.create(storage);
    const originalHello = {...hello, alias: ' 旅行卡 😀 '};
    const authority = {
      authorityUrl: 'https://authority.example',
      authorityPublicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(7)),
    };
    const prepared = await service.prepareFresh(
      information,
      originalHello,
      undefined,
      ['otp', 'security-key'],
      authority,
    );
    storage.mutate(state => {
      const operation = state.operations[0];
      operation.phase = checkpoint ? 'replacing' : 'ready';
      operation.checkpoint = checkpoint;
      operation.restarted = checkpoint ? undefined : true;
      operation.rejectedItems = [{index: '01', reason: 'Old attempt'}];
      operation.previousGrantTokens = {[hex(aid)]: 'old-token-hash'};
      operation.previousGrantTokensChecksum = `0x${createHash('sha256')
        .update(JSON.stringify(operation.previousGrantTokens))
        .digest('hex')}`;
    });
    service = await CardMaintenanceService.create(storage);
    service.holdSecretPIN(prepared.card, 'Secret-42');
    const unrelated = {publicKey: 'unrelated-card'};
    service.holdSecretPIN(unrelated, 'Other-42');
    bundleHashes[0] = 'new-identity-image';
    const reset = await service.restart(prepared.id);
    assert.deepEqual(reset, {
      ...prepared,
      restarted: true,
      bundleHashes: [...bundleHashes],
    });
    assert.equal(service.secretPIN(prepared.card), undefined);
    assert.equal(service.secretPIN(unrelated), 'Other-42');
    assert.deepEqual((await storage.get()).operations, [reset]);

    service = await CardMaintenanceService.create(storage);
    const incompleteHello = {
      ...hello,
      publicKey: bytes(`04${'33'.repeat(64)}`),
      alias: false,
    };
    assert.equal(
      service.matchOperation({
        hello: incompleteHello,
        cardInformation: information,
      }).id,
      prepared.id,
    );
    assert.equal(service.matchOperation({hello: incompleteHello}), undefined);
    replacement = async (_session, options) => {
      assert.equal(options.fresh, true);
      assert.equal(options.checkpoint, undefined);
      assert.equal(options.expectedCardId, hex(originalHello.id));
      assert.equal(options.expectedCardAlias, originalHello.alias);
      assert.deepEqual(options.selectedOptionalStages, ['otp', 'security-key']);
      assert.equal(options.authorityUrl, authority.authorityUrl);
      assert.deepEqual(
        options.authorityPublicKey,
        authority.authorityPublicKey,
      );
      await options.onCheckpoint('remove-monoid-instance');
      return incompleteHello;
    };
    await service.replace('session', prepared.id);
    assert.equal(service.get(prepared.id).checkpoint, 'remove-monoid-instance');
    assert.equal(service.get(prepared.id).card.alias, originalHello.alias);
  });
}

for (const mode of ['update', 'reinstall', 'fresh']) {
  test(`Start over refuses a ${mode} batch without changing the operation or its held PIN`, async () => {
    const storage = storageFixture();
    let service = await CardMaintenanceService.create(storage);
    const operation =
      mode === 'fresh'
        ? await service.prepareFresh(information, hello)
        : await service.prepare(cardFixture(), {
            mode,
            cardInformation: information,
            appletAid: hex(aid),
          });
    storage.mutate(state => {
      state.operations[0].phase = 'replacing';
      state.operations[0].checkpoint = 'verify';
      state.operations[0].batchId = 'batch';
    });
    service = await CardMaintenanceService.create(storage);
    service.holdSecretPIN(operation.card, 'Secret-42');
    const before = await storage.get();
    await assert.rejects(service.restart(operation.id), /maintenance batch/);
    assert.deepEqual(await storage.get(), before);
    assert.deepEqual(service.get(operation.id), before.operations[0]);
    assert.equal(service.secretPIN(operation.card), 'Secret-42');
  });
}

for (const failure of ['write', 'readback']) {
  test(`fresh Start over requires storage ${failure} before publishing or dropping its PIN`, async () => {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
    const operation = await service.prepareFresh(information, {
      ...hello,
      alias: 'Daily',
    });
    await service.replace('session', operation.id);
    const saved = (await storage.get()).operations[0];
    service.holdSecretPIN(operation.card, 'Secret-42');
    if (failure === 'write') storage.failWrite = true;
    else storage.corruptRead = true;
    await assert.rejects(service.restart(operation.id), /Disk full|verify/);
    assert.deepEqual(service.get(operation.id), saved);
    assert.equal(service.secretPIN(operation.card), 'Secret-42');
  });
}

test('fresh Start over holds the maintenance mutex through its verified write', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const operation = await service.prepareFresh(information, {
    ...hello,
    alias: 'Daily',
  });
  await service.replace('session', operation.id);
  let entered;
  let release;
  const saving = new Promise(resolve => {
    entered = resolve;
  });
  const blocked = new Promise(resolve => {
    release = resolve;
  });
  storage.afterSet = async value => {
    if (value.operations[0]?.phase === 'ready') {
      entered();
      await blocked;
    }
  };
  const resetting = service.restart(operation.id);
  await saving;
  try {
    await assert.rejects(service.restart(operation.id), /already running/);
    await assert.rejects(
      service.replace('session', operation.id),
      /already running/,
    );
    assert.equal(service.get(operation.id).checkpoint, 'verify');
  } finally {
    release();
  }
  await resetting;
  assert.equal(service.get(operation.id).phase, 'ready');
  assert.equal(service.get(operation.id).checkpoint, undefined);
});

for (const [phase, checkpoint] of [
  ['ready', 'remove-monoid-instance'],
  ['replacing', undefined],
  ['replacing', 'remove-monoid-instance'],
  ['restore', 'verify'],
]) {
  test(`discard rejects ${phase} with ${checkpoint ?? 'no'} checkpoint and preserves the recovery data`, async () => {
    const storage = storageFixture();
    let service = await CardMaintenanceService.create(storage);
    const card = cardFixture();
    card.state.bundle = new Uint8Array(32).fill(9);
    card.grants = [
      {
        aid: bytes('a0000006472f0001'),
        seed: {index: sourceItems[0].index, domain: bytes('aabb')},
      },
    ];
    const draft = await service.prepare(card, {
      mode: 'reinstall',
      cardInformation: information,
      appletAid: hex(aid),
    });
    await service.saveBundleRecovery(draft, bundleRecovery(card));
    storage.mutate(state => {
      state.operations[0].phase = phase;
      state.operations[0].checkpoint = checkpoint;
    });
    service = await CardMaintenanceService.create(storage);
    const saved = structuredClone(await storage.get());
    await assert.rejects(service.discardPrepared(draft.id), /already started/);
    assert.deepEqual(await storage.get(), saved);
    assert.deepEqual(service.get(draft.id), saved.operations[0]);
  });
}

for (const failure of ['write', 'readback']) {
  test(`discard requires a successful storage ${failure} before publishing the removal`, async () => {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
    const card = cardFixture();
    card.state.bundle = new Uint8Array(32).fill(9);
    const draft = await service.prepare(card, {
      mode: 'reinstall',
      cardInformation: information,
      appletAid: hex(aid),
    });
    const saved = await service.saveBundleRecovery(draft, bundleRecovery(card));
    service.holdSecretPIN(saved.card, 'Secret-42');
    if (failure === 'write') storage.failWrite = true;
    else {
      const get = storage.get;
      storage.get = async function () {
        const value = await get.call(this);
        if (value && value.operations.length === 0)
          value.operations = [JSON.parse(JSON.stringify(saved))];
        return value;
      };
    }
    await assert.rejects(service.discardPrepared(saved.id), /Disk full|verify/);
    assert.equal(service.secretPIN(saved.card), 'Secret-42');
    assert.deepEqual(service.get(saved.id), saved);
    assert.deepEqual(card.imports, []);
  });
}

test('discard holds the maintenance mutex until persistence finishes and cannot race replacement', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  const operation = await service.prepare(card, {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
  });
  let entered;
  let release;
  const saving = new Promise(resolve => {
    entered = resolve;
  });
  const blocked = new Promise(resolve => {
    release = resolve;
  });
  storage.afterSet = async value => {
    if (!value.operations.length) {
      entered();
      await blocked;
    }
  };
  const discarding = service.discardPrepared(operation.id);
  await saving;
  try {
    await assert.rejects(
      service.discardPrepared(operation.id),
      /already running/,
    );
    await assert.rejects(
      service.replace('session', operation.id),
      /already running/,
    );
    assert.equal(service.get(operation.id).id, operation.id);
  } finally {
    release();
  }
  await discarding;
  assert.equal(service.get(operation.id), undefined);
  const writes = storage.writes.length;
  await service.discardPrepared(operation.id);
  assert.equal(storage.writes.length, writes);
});

test('recovery import reports each rejection or conflict, restores others and retains the complete archive', async () => {
  const service = await CardMaintenanceService.create(storageFixture()),
    card = cardFixture();
  const operation = await service.prepare(card, {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
  });
  await service.replace('session', operation.id);
  const original = JSON.parse(
    JSON.stringify(service.get(operation.id).archive),
  );
  const first = card.items[0],
    second = card.items[1],
    third = card.items[2];
  card.restored.set(hex(first.index), {...first, alias: 'Different'});
  const importItem = card.importItem.bind(card);
  card.importItem = request =>
    hex(request.index) === hex(second.index)
      ? Promise.reject(new CBORAppletError({code: 'INVALID_PARAMETER'}))
      : importItem(request);
  const {issues} = await service.restore(card, operation.id);
  assert.deepEqual(issues, [
    {index: hex(first.index), reason: 'Conflict'},
    {index: hex(second.index), reason: 'INVALID_PARAMETER'},
  ]);
  assert.ok(card.restored.has(hex(third.index)));
  assert.deepEqual(service.get(operation.id).archive, original);
  assert.equal(service.get(operation.id).phase, 'restore');
  card.restored.set(hex(first.index), first);
  card.importItem = importItem;
  assert.deepEqual(await service.restore(card, operation.id), {
    complete: true,
    issues: [],
    droppedGrants: [],
  });
  assert.equal(service.get(operation.id), undefined);
  assert.equal(
    card.imports.filter(request => hex(request.index) === hex(third.index))
      .length,
    1,
  );
});

test('recovery compares readable opaque data and keeps conflicting contents', async () => {
  const service = await CardMaintenanceService.create(storageFixture()),
    card = cardFixture();
  const operation = await service.prepare(card, {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
  });
  await service.replace('session', operation.id);
  const item = card.items[1];
  card.restored.set(hex(item.index), {...item, data: bytes('ffff')});
  const {issues} = await service.restore(card, operation.id);
  assert.deepEqual(issues, [{index: hex(item.index), reason: 'Conflict'}]);
  assert.equal(hex(card.restored.get(hex(item.index)).data), 'ffff');
  assert.equal(card.restored.size, 3);
  assert.ok(service.get(operation.id).archive);
});

test('an item-local backup rejection still exports later items but never saves a partial archive', async () => {
  const service = await CardMaintenanceService.create(storageFixture()),
    card = cardFixture();
  const exportItem = card.exportItem.bind(card);
  card.exportItem = request =>
    hex(request.index) === hex(card.items[1].index)
      ? Promise.reject(new CBORAppletError({code: 'INVALID_PARAMETER'}))
      : exportItem(request);
  await assert.rejects(
    service.prepare(card, {
      mode: 'reinstall',
      cardInformation: information,
      appletAid: hex(aid),
    }),
    new RegExp(`${hex(card.items[1].index)}: cannot export recovery`),
  );
  assert.deepEqual(
    card.exports.map(request => hex(request.index)),
    [hex(card.items[0].index), hex(card.items[2].index)],
  );
  assert.deepEqual(service.operations, []);
});

async function batchFixture(
  service,
  count = 2,
  mode = 'reinstall',
  optional = [],
) {
  const cards = Array.from({length: count}, (_, index) => {
    const card = cardFixture();
    card.state.id = bytes(`0000000${index + 1}`);
    card.state.publicKey = bytes(
      `04${(index + 3).toString(16).padStart(2, '0').repeat(64)}`,
    );
    card.state.bundle = new Uint8Array(32).fill(4);
    return card;
  });
  const preparations = [];
  for (const [index, card] of cards.entries()) {
    const operation = await service.prepare(card, {
      mode,
      selectedOptionalStages: optional[index],
      cardInformation: {
        ...information,
        cplc: {...information.cplc, icSerialNumber: `card-${index}`},
      },
      appletAid: hex(aid),
    });
    preparations.push({operation, recovery: bundleRecovery(card)});
  }
  return {cards, preparations};
}

test('a batch can save after obsolete operations for earlier identities of the same chip are discarded', async () => {
  const storage = storageFixture();
  let service = await CardMaintenanceService.create(storage);
  const {preparations} = await batchFixture(service);
  const target = preparations[0].operation;
  await storage.set('cardMaintenance', {
    version: 1,
    operations: ['55', '66'].map(key => ({
      ...target,
      id: `obsolete-${key}`,
      phase: 'manual-restore',
      checkpoint: 'verify',
      card: {...target.card, publicKey: `04${key.repeat(64)}`},
    })),
  });
  service = await CardMaintenanceService.create(storage);
  assert.deepEqual(service.operations, []);
  assert.deepEqual((await storage.get()).operations, []);
  const batch = await service.saveBundleRecoveryBatch(preparations);
  assert.deepEqual(
    batch.targets.map(target => target.operationId),
    preparations.map(({operation}) => operation.id),
  );
  service = await CardMaintenanceService.create(storage);
  assert.deepEqual(service.batches, [batch]);
  assert.equal(service.operations.length, 2);
  for (const {operation} of preparations) {
    const saved = service.get(operation.id);
    assert.equal(saved.phase, 'ready');
    assert.deepEqual(saved.card, operation.card);
    assert.equal(saved.archive.items.length, sourceItems.length);
  }
});

test('a batch persists every archive before replacement and resumes with at most one unrestored card', async () => {
  const storage = storageFixture();
  let service = await CardMaintenanceService.create(storage);
  const {cards, preparations} = await batchFixture(service, 3);
  const batch = await service.saveBundleRecoveryBatch(preparations);
  assert.equal(storage.writes.length, 1);
  assert.equal(
    storage.writes[0].operations.filter(item => item.archive).length,
    3,
  );
  const empty = new Set();
  replacement = async (_session, options) => {
    assert.equal(empty.size, 0);
    empty.add(options.expectedPublicKey);
    await options.onCheckpoint('verify');
    return structuredClone(
      cards.find(
        card => hex(card.state.publicKey) === options.expectedPublicKey,
      ).state,
    );
  };
  const first = preparations[0].operation.id;
  const second = preparations[1].operation.id;
  await assert.rejects(service.replace('session', second), /previous card/);
  await service.replace('session', first);
  cards[0].failImport = 1;
  await assert.rejects(service.restore(cards[0], first), /Tag lost/);
  service = await CardMaintenanceService.create(storage);
  await assert.rejects(service.replace('session', second), /previous card/);
  await assert.rejects(service.discardPrepared(second), /already started/);
  cards[0].failImport = -1;
  await service.restore(cards[0], first);
  empty.clear();
  assert.equal(
    cards[0].imports.length,
    sourceItems.length,
    'lost import ACK was reconciled without replay',
  );
  assert.equal(service.batches[0].targets[0].complete, true);
  service = await CardMaintenanceService.create(storage);
  for (let index = 1; index < 3; index++) {
    const id = preparations[index].operation.id;
    await service.replace('session', id);
    await service.restore(cards[index], id);
    empty.clear();
  }
  assert.equal(service.operations.length, 0);
  assert.ok(service.batches[0].targets.every(target => target.complete));
  for (const {operation} of preparations)
    service.holdSecretPIN(operation.card, 'Secret-42');
  await service.dismissBatch(batch.id);
  for (const {operation} of preparations)
    assert.equal(service.secretPIN(operation.card), undefined);
  assert.equal(service.batches.length, 0);
});

test('a partial or unverified batch is never published for replacement', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const {preparations} = await batchFixture(service);
  const invalid = structuredClone(preparations);
  invalid[1].recovery.source.publicKey = invalid[1].operation.card.publicKey;
  await assert.rejects(service.saveBundleRecoveryBatch(invalid), /same Bundle/);
  assert.equal(storage.writes.length, 0);
  storage.corruptRead = true;
  await assert.rejects(service.saveBundleRecoveryBatch(preparations), /verify/);
  assert.equal(service.operations.length, 0);
  assert.equal(service.batches.length, 0);
});

test('an empty target still has to verify restoration before the next target is replaceable', async () => {
  const storage = storageFixture();
  let service = await CardMaintenanceService.create(storage);
  const {cards, preparations} = await batchFixture(service);
  for (const card of cards) card.items = [];
  for (const item of preparations) item.recovery.items = [];
  await service.saveBundleRecoveryBatch(preparations);
  replacement = async () => structuredClone(cards[0].state);
  await service.replace('session', preparations[0].operation.id);
  service = await CardMaintenanceService.create(storage);
  await assert.rejects(
    service.replace('session', preparations[1].operation.id),
    /previous card/,
  );
  await service.restore(cards[0], preparations[0].operation.id);
  assert.equal(service.batches[0].targets[0].complete, true);
});

test('optional recovery verifies the new token and protects its saved comparison from corruption', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.grants = [
    {
      aid: bytes('a0000006472f0001'),
      types: [[-3839, true]],
      tokenHash: new Uint8Array(32),
    },
  ];
  const operation = await service.prepare(card, {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
    selectedOptionalStages: ['security-key'],
    replaceStages: ['security-key'],
  });
  replacement = async () => structuredClone(card.state);
  await service.replace('session', operation.id);
  card.setAppletGrant = async () => {};
  await assert.rejects(
    service.restore(card, operation.id),
    /Could not verify applet access/,
  );
  assert.ok(service.get(operation.id));
  storage.mutate(
    state =>
      (state.operations[0].previousGrantTokens['a0000006472f0001'] =
        'ff'.repeat(32)),
  );
  await assert.rejects(
    CardMaintenanceService.create(storage),
    /recovery data is invalid/,
  );
});

for (const mode of ['update', 'reinstall']) {
  test(`${mode} restores each batch target's own optional applet list after restart`, async () => {
    const storage = storageFixture();
    let service = await CardMaintenanceService.create(storage);
    const optional = [['otp'], ['security-key'], []];
    const {cards, preparations} = await batchFixture(
      service,
      3,
      mode,
      optional,
    );
    await service.saveBundleRecoveryBatch(preparations);
    for (const [index, card] of cards.entries()) {
      service = await CardMaintenanceService.create(storage);
      replacement = async (_session, options) => {
        assert.deepEqual(options.selectedOptionalStages, optional[index]);
        await options.onCheckpoint('verify');
        return structuredClone(card.state);
      };
      const id = preparations[index].operation.id;
      await service.replace('session', id);
      await service.restore(card, id);
    }
    assert.ok(service.batches[0].targets.every(target => target.complete));
  });
}

async function rejectedRecovery({bundle = false} = {}) {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  const missingKey = bytes('05140000000000000001');
  card.items.push({index: missingKey, secret: true});
  const securityKeyAid = bytes('a0000006472f0001');
  const otpAid = bytes('f06d6f6e6f69640501');
  card.grants = [
    {
      aid: securityKeyAid,
      seed: {index: card.items[0].index, domain: bytes('aabb')},
    },
    {aid: otpAid, keys: [{index: missingKey, type: 'hmac'}]},
    {aid: bytes('f06d6f6e6f69640601'), types: [[-3583, false]]},
  ];
  if (bundle) card.state.bundle = new Uint8Array(32).fill(9);
  let operation = await service.prepare(card, {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
    selectedOptionalStages: ['otp', 'security-key'],
  });
  if (bundle) {
    const next = cardFixture();
    next.state.bundle = card.state.bundle;
    next.state.publicKey = bytes(`04${'33'.repeat(64)}`);
    next.state.id = bytes('33445566');
    const nextOperation = await service.prepare(next, {
      mode: 'update',
      appletAid: hex(aid),
      cardInformation: {...information, cplc: {icSerialNumber: 'next'}},
    });
    await service.saveBundleRecoveryBatch([
      {operation, recovery: bundleRecovery(card)},
      {operation: nextOperation, recovery: bundleRecovery(next)},
    ]);
    operation = service.get(operation.id);
  }
  replacement = async () => structuredClone(card.state);
  await service.replace('session', operation.id);
  card.grants = [];
  // A list after replacement reflects only actual imported records.
  card.list = async () => ({items: [...card.restored.values()]});
  const rejected = [hex(card.items[1].index), hex(missingKey)];
  const importItem = card.importItem.bind(card);
  card.importItem = request =>
    rejected.includes(hex(request.index))
      ? Promise.reject(new CBORAppletError({code: 'INVALID_PARAMETER'}))
      : importItem(request);
  return {storage, service, card, operation, rejected, securityKeyAid, otpAid};
}

for (const bundle of [false, true]) {
  test(`explicit finish omits rejected items, restores valid grants and discards the ${bundle ? 'batch' : 'single-card'} archive`, async () => {
    const {
      storage,
      card,
      operation,
      rejected,
      securityKeyAid,
      otpAid,
      ...fixture
    } = await rejectedRecovery({bundle});
    let {service} = fixture;
    service.holdSecretPIN(operation.card, 'Secret-42');
    const result = await service.restore(card, operation.id);
    assert.equal(service.secretPIN(operation.card), 'Secret-42');
    assert.equal(result.complete, false);
    assert.deepEqual(
      new Set(result.issues.map(item => item.index)),
      new Set(rejected),
    );
    assert.deepEqual(card.grants, []);
    assert.ok(service.get(operation.id).archive);
    if (bundle) {
      await assert.rejects(
        service.replace('session', service.batches[0].targets[1].operationId),
        /previous card/,
      );
    }
    service = await CardMaintenanceService.create(storage);
    service.holdSecretPIN(operation.card, 'Secret-42');
    card.importItem = () =>
      assert.fail('Finish must not repeat rejected imports');
    const finished = await service.restore(
      card,
      operation.id,
      undefined,
      undefined,
      undefined,
      rejected,
    );
    assert.deepEqual(finished, {
      complete: true,
      issues: result.issues,
      droppedGrants: [hex(otpAid)],
    });
    assert.equal(service.secretPIN(operation.card), undefined);
    assert.deepEqual(
      card.grants.map(grant => hex(grant.aid)),
      [hex(securityKeyAid), 'f06d6f6e6f69640601'],
    );
    assert.equal(service.get(operation.id), undefined);
    const persisted = await storage.get();
    assert.equal(
      persisted.operations.some(item => item.id === operation.id),
      false,
    );
    if (bundle) {
      assert.equal(service.batches[0].targets[0].complete, true);
      const next = service.get(service.batches[0].targets[1].operationId);
      replacement = async () => ({
        ...card.state,
        publicKey: bytes(next.card.publicKey),
        id: bytes(next.card.id),
      });
      await service.replace('session', next.id);
      assert.equal(service.get(next.id).phase, 'restore');
    }
  });
}

test('finishing a conflict preserves the on-card item and drops grants requiring its archived version', async () => {
  const {service, card, operation, rejected, securityKeyAid, otpAid} =
    await rejectedRecovery();
  const seed = card.items[0];
  card.restored.set(hex(seed.index), {...seed, alias: 'Keep this conflict'});
  const result = await service.restore(card, operation.id);
  const skipped = [hex(seed.index), ...rejected];
  assert.deepEqual(
    result.issues.map(issue => issue.index),
    skipped,
  );
  const finished = await service.restore(
    card,
    operation.id,
    undefined,
    undefined,
    undefined,
    skipped,
  );
  assert.equal(finished.complete, true);
  assert.deepEqual(finished.droppedGrants, [hex(securityKeyAid), hex(otpAid)]);
  assert.equal(card.restored.get(hex(seed.index)).alias, 'Keep this conflict');
});

for (const failure of [
  new Error('Tag lost'),
  new CBORAppletError({code: 'INVALID_PIN'}),
  Object.assign(new Error('Cancelled'), {code: 'CANCELLED'}),
]) {
  test(`${failure.message} invalidates a previous finish offer and retains recovery`, async () => {
    const {service, card, operation, rejected} = await rejectedRecovery();
    await service.restore(card, operation.id);
    assert.ok(service.get(operation.id).rejectedItems);
    card.hello = async () => {
      throw failure;
    };
    await assert.rejects(
      service.restore(card, operation.id),
      error => error === failure,
    );
    assert.equal(service.get(operation.id).rejectedItems, undefined);
    await assert.rejects(
      service.restore(
        card,
        operation.id,
        undefined,
        undefined,
        undefined,
        rejected,
      ),
      /Retry item recovery/,
    );
    assert.ok(service.get(operation.id).archive);
  });
}

test('finish verifies the remaining inventory before restoring grants or discarding recovery', async () => {
  const {service, card, operation, rejected} = await rejectedRecovery();
  await service.restore(card, operation.id);
  card.restored.set('ffff0000000000000099', {
    index: bytes('ffff0000000000000099'),
    secret: false,
  });
  await assert.rejects(
    service.restore(
      card,
      operation.id,
      undefined,
      undefined,
      undefined,
      rejected,
    ),
    /does not match/,
  );
  assert.deepEqual(card.grants, []);
  assert.ok(service.get(operation.id).archive);
});

test('an uncertain grant after confirmation is reconciled on explicit retry without replay', async () => {
  const {service, card, operation, rejected} = await rejectedRecovery();
  await service.restore(card, operation.id);
  const setGrant = card.setAppletGrant.bind(card);
  let writes = 0;
  card.setAppletGrant = async request => {
    writes++;
    await setGrant(request);
    throw new Error('Grant ACK lost');
  };
  await assert.rejects(
    service.restore(
      card,
      operation.id,
      undefined,
      undefined,
      undefined,
      rejected,
    ),
    /ACK lost/,
  );
  assert.ok(service.get(operation.id).archive);
  assert.equal(service.get(operation.id).rejectedItems, undefined);
  await service.restore(card, operation.id);
  card.setAppletGrant = async request => {
    writes++;
    await setGrant(request);
  };
  const result = await service.restore(
    card,
    operation.id,
    undefined,
    undefined,
    undefined,
    rejected,
  );
  assert.equal(result.complete, true);
  assert.equal(
    writes,
    2,
    'one write for each retained grant, with no replay of the lost ACK',
  );
});

test('an uncertain import after a definite rejection cannot authorize finishing', async () => {
  const {service, card, operation, rejected} = await rejectedRecovery();
  card.failImport = 2;
  await assert.rejects(service.restore(card, operation.id), /Tag lost/);
  assert.equal(service.get(operation.id).rejectedItems, undefined);
  await assert.rejects(
    service.restore(
      card,
      operation.id,
      undefined,
      undefined,
      undefined,
      rejected,
    ),
    /Retry item recovery/,
  );
  assert.ok(service.get(operation.id).archive);
  card.failImport = -1;
  await service.restore(card, operation.id);
  assert.equal(
    card.imports.length,
    2,
    'acknowledged and uncertain imports are both reconciled without replay',
  );
});
