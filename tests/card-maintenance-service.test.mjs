import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {beforeEach, mock, test} from 'node:test';

import {encode} from 'cbor2';

import {
  CardItemExistsError,
  CardItemNotFoundError,
} from '../.bld/app/@lib/cbor-applet.js';

let replacement;
let scannedHello;
const bundleHashes = ['identity-image', 'library-image', 'monoid-image'];
const catalog = [
  {stage: 'identity', appletAid: 'f06d6f6e6f69640001'},
  {stage: 'library'},
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

async function saveLegacyManual(storage, operation) {
  await storage.set('cardMaintenance', {
    version: 1,
    operations: [{...operation, phase: 'manual-restore', checkpoint: 'verify'}],
  });
  return CardMaintenanceService.create(storage);
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
  let service = await CardMaintenanceService.create(storage);
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
  service = await saveLegacyManual(storage, operation);
  const recovery = structuredClone(await storage.get());
  await assert.rejects(service.prepare(card, options), /Continue the existing/);
  assert.deepEqual(await storage.get(), recovery);
  assert.equal(service.get(operation.id).phase, 'manual-restore');
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

test('a legacy Bundle reminder without grants must be restored before any new maintenance', async () => {
  const storage = storageFixture();
  let service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(0x42);
  const options = {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
    selectedOptionalStages: ['security-key'],
  };
  const original = await service.prepare(card, options);
  service = await saveLegacyManual(storage, original);
  const saved = structuredClone(await storage.get());
  for (const replaceStages of [undefined, ['security-key']]) {
    await assert.rejects(
      service.prepare(card, {...options, replaceStages}),
      /Continue the existing/,
    );
    assert.deepEqual(await storage.get(), saved);
  }
  await service.saveBundleRecovery(original, bundleRecovery(card));
  await service.restore(card, original.id);
  assert.equal(service.get(original.id), undefined);
  const optional = await service.prepare(card, {
    ...options,
    replaceStages: ['security-key'],
  });
  replacement = async () => structuredClone(card.state);
  await service.replace('session', optional.id);
  assert.equal(service.get(optional.id), undefined);
});

for (const kind of ['empty card', 'optional without grants']) {
  test(`${kind} replacement finishes without retaining an empty automatic recovery task`, async () => {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
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

test('restart removes verified empty automatic recovery but retains Bundle reminders and uncertain checkpoints', async () => {
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
      {...template, id: 'manual', phase: 'manual-restore'},
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
    ['manual', 'uncertain'],
  );
  assert.deepEqual(await storage.get(), {
    ...before,
    operations: before.operations.slice(1),
  });
});

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
    assert.deepEqual(progress.at(-1), {stage: 'verifying-grants'});
    const result = await listGrants(request);
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
  test(`${mode} preflight failure discards only the unstarted preparation`, async () => {
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
  test(`cancellation ${stage} clears the preparation before any checkpoint`, async () => {
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

test('a failed checkpoint save cannot authorize deletion and leaves no unstarted operation', async () => {
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

test('restart discards unstarted and completed Fresh setup records while preserving recovery data and installations', async () => {
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
      {
        ...withoutArchive,
        id: 'manual',
        phase: 'manual-restore',
        card: {...template.card, bundle: '09'.repeat(32)},
      },
    ];
  });
  const before = await storage.get();
  const restarted = await CardMaintenanceService.create(storage);
  assert.deepEqual(
    restarted.operations.map(item => item.id),
    ['checkpoint', 'replacing', 'restore', 'manual'],
  );
  assert.deepEqual(await storage.get(), {
    ...before,
    operations: before.operations
      .filter(item => !['unstarted', 'setup'].includes(item.id))
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
  for (const mismatch of ['publicKey', 'aid', 'bundle']) {
    const service = await CardMaintenanceService.create(storageFixture());
    const card = cardFixture();
    const operation = await service.prepare(card, {
      mode: 'update',
      cardInformation: information,
      appletAid: hex(aid),
    });
    await service.replace('session', operation.id);
    if (mismatch === 'publicKey')
      card.state.publicKey = bytes(`04${'22'.repeat(64)}`);
    else if (mismatch === 'aid') card.aid = bytes('f06d6f6e6f69640202');
    else card.state.bundle = new Uint8Array(32);
    await assert.rejects(
      service.restore(card, operation.id),
      /Wrong card|Bundle changed/,
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

test('a legacy Bundle reminder receives a peer archive without reinstalling or changing its saved access', async () => {
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
  const operation = await service.prepare(card, {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
  });
  service = await saveLegacyManual(storage, operation);
  const next = await service.saveBundleRecovery(
    {...operation, grants: [], grantsChecksum: ''},
    bundleRecovery(card),
  );
  assert.equal(next.id, operation.id);
  assert.equal(next.phase, 'restore');
  assert.equal(next.checkpoint, 'verify');
  assert.deepEqual(next.grants, operation.grants);
  replacement = async () => {
    throw new Error('Must not reinstall');
  };
  service = await CardMaintenanceService.create(storage);
  await service.restore(card, operation.id, undefined, undefined, [
    'a0000006472f0001',
  ]);
  assert.equal(card.imports.length, sourceItems.length);
  assert.equal(service.get(operation.id), undefined);
});

test('failed peer archive saving keeps the previous Bundle reminder and grants', async () => {
  const storage = storageFixture();
  let service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(9);
  const operation = await service.prepare(card, {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
  });
  service = await saveLegacyManual(storage, operation);
  const previous = structuredClone(await storage.get());
  storage.failWrite = true;
  await assert.rejects(
    service.saveBundleRecovery(operation, bundleRecovery(card)),
    /Disk full/,
  );
  assert.deepEqual(await storage.get(), previous);
  assert.equal(service.get(operation.id).phase, 'manual-restore');
  storage.failWrite = false;
  service = await CardMaintenanceService.create(storage);
  assert.equal(service.get(operation.id).phase, 'manual-restore');
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

test('an active Fresh operation takes precedence over a Bundle recovery reminder', async () => {
  const storage = storageFixture();
  let service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(9);
  const ordinary = await service.prepare(card, {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
  });
  replacement = async () => structuredClone(card.state);
  service = await saveLegacyManual(storage, ordinary);
  const fresh = await service.prepareFresh(information);
  assert.equal(fresh.card.id, hex(card.state.id));
  replacement = async (_session, options) => {
    assert.equal(options.expectedCardId, hex(card.state.id));
    await options.onCheckpoint('remove-monoid-instance');
    throw new Error('Tag lost');
  };
  await assert.rejects(service.replace('session', fresh.id), /Tag lost/);
  const resumed = await CardMaintenanceService.create(storage);
  assert.equal(resumed.get(fresh.id).card.id, hex(card.state.id));
  assert.equal(
    service.matchOperation({hello: card.state, cardInformation: information})
      .id,
    fresh.id,
  );
  assert.ok(service.get(ordinary.id));
});

test('fresh reinstall works without Hello and clears only its own completed operation', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const first = await service.prepareFresh(information);
  const second = await service.prepareFresh({
    ...information,
    cplc: {icSerialNumber: '87654321'},
  });
  replacement = async (_session, options) => {
    assert.equal(options.fresh, true);
    return structuredClone(hello);
  };
  assert.equal(
    service.matchOperation({cardInformation: information, appletAid: hex(aid)})
      .id,
    first.id,
  );
  await service.replace('session', first.id);
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
    await assert.rejects(
      service.replace('session', operation.id),
      /Storage interrupted/,
    );
    assert.equal(service.get(operation.id).phase, 'replacing');
    assert.equal(service.get(operation.id).checkpoint, 'verify');
    assert.equal((await storage.get()).operations[0].checkpoint, 'verify');
    storage.set = set;
    replacement = async (_session, options) => {
      assert.equal(options.checkpoint, 'verify');
      return structuredClone(hello);
    };
    await service.replace('retry-session', operation.id);
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

test('Fresh returns its new Identity without retaining PIN setup or removing another recovery archive', async () => {
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
  replacement = async () => newHello;
  assert.deepEqual(await service.replace('session', fresh.id), newHello);
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

test('a failed manual recovery readback retains the previous in-memory reminder without deleting accepted recovery data', async () => {
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
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  service = await saveLegacyManual(storage, draft);
  storage.corruptRead = true;
  await assert.rejects(
    service.saveBundleRecovery(draft, bundleRecovery(card)),
    /verify/,
  );
  assert.equal(service.get(draft.id).phase, 'manual-restore');
  assert.deepEqual(service.get(draft.id).grants, draft.grants);
  storage.corruptRead = false;
  const persisted = (await storage.get()).operations[0];
  assert.equal(persisted.phase, 'restore');
  assert.equal(persisted.archive.items.length, sourceItems.length);
  const retried = await service.saveBundleRecovery(draft, bundleRecovery(card));
  assert.deepEqual(retried.grants, draft.grants);
  service = await CardMaintenanceService.create(storage);
  assert.equal(
    service.get(draft.id).archive.checksum,
    persisted.archive.checksum,
  );
});

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
  test(`a peer missing a legacy grant's ${missing} is rejected before saving and another peer can be chosen`, async () => {
    const storage = storageFixture();
    let service = await CardMaintenanceService.create(storage);
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
    service = await saveLegacyManual(storage, draft);
    const previous = structuredClone(await storage.get());
    const missingDependency = bundleRecovery(card);
    missingDependency.items = missingDependency.items.filter(
      item => item.index !== hex(index),
    );
    await assert.rejects(
      service.saveBundleRecovery(
        {...draft, grants: [], grantsChecksum: ''},
        missingDependency,
      ),
      /Restore applet keys first/,
    );
    assert.deepEqual(await storage.get(), previous);
    assert.deepEqual(service.get(draft.id).grants, draft.grants);
    assert.equal(service.get(draft.id).phase, 'manual-restore');
    const saved = await service.saveBundleRecovery(draft, bundleRecovery(card));
    assert.equal(saved.phase, 'restore');
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

test('cancellation after a legacy recovery save ACK returns the committed operation without losing its archive', async () => {
  const storage = storageFixture();
  let service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(9);
  const draft = await service.prepare(card, {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  service = await saveLegacyManual(storage, draft);
  const controller = new AbortController();
  storage.afterSet = value => {
    if (value.operations[0]?.phase === 'restore') controller.abort();
  };
  const saved = await service.saveBundleRecovery(
    draft,
    bundleRecovery(card),
    controller.signal,
  );
  assert.equal(controller.signal.aborted, true);
  assert.equal(saved.phase, 'restore');
  assert.equal(saved.archive.items.length, sourceItems.length);
  assert.deepEqual(saved, service.get(draft.id));
  service = await CardMaintenanceService.create(storage);
  assert.deepEqual(service.get(draft.id), saved);
  assert.deepEqual(card.imports, []);
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
  await service.discardPrepared(original.id);
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

for (const [phase, checkpoint] of [
  ['ready', 'remove-monoid-instance'],
  ['replacing', undefined],
  ['replacing', 'remove-monoid-instance'],
  ['restore', 'verify'],
  ['manual-restore', 'verify'],
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
      if (phase === 'manual-restore') delete state.operations[0].archive;
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
