import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {beforeEach, mock, test} from 'node:test';

import {encode} from 'cbor2';

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

const {CardMaintenanceService} = await import(
  '../.bld/app/@services/card-maintenance-service.js'
);
const {MonoidCardError} = await import('../.bld/app/@lib/monoid/card-error.js');
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
  pins: {access: 5, secret: 5},
};
const sourceItems = [
  {index: bytes('02000000000000000001'), secret: true},
  {
    index: bytes('0f010000000000000002'),
    key: bytes(''),
    alias: '',
    secret: false,
  },
  {
    index: bytes('ffff0000000000000003'),
    key: bytes('aa'),
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
      return {key: item.key, alias: item.alias, data};
    },
    async importItem(request) {
      this.imports.push(request);
      if (this.imports.length === this.failImport) throw new Error('Tag lost');
    },
  };
  return card;
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
    const operation = await service.prepare(card, {
      mode: 'update',
      cardInformation: information,
      appletAid: hex(aid),
      selectedOptionalStages: ['security-key'],
    });
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
    if (bundle) {
      assert.deepEqual(card.exports, []);
      assert.equal(service.get(operation.id).phase, 'manual-restore');
      assert.deepEqual(service.get(operation.id).grants, []);
    } else {
      assert.equal(card.imports.length, sourceItems.length);
      assert.equal(service.get(operation.id), undefined);
    }
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
      seed: {index: bytes('02400000000000000001'), domain: bytes('00ff80')},
      tokenHash: new Uint8Array(32),
    },
  ];
  const options = {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
    selectedOptionalStages: ['security-key'],
  };
  const operation = await service.prepare(card, options);
  replacement = async () => structuredClone(card.state);
  await service.replace('session', operation.id);
  service = await CardMaintenanceService.create(storage);
  const recovery = structuredClone(await storage.get());
  await assert.rejects(service.prepare(card, options), /Continue the existing/);
  assert.deepEqual(await storage.get(), recovery);
  assert.equal(service.get(operation.id).phase, 'manual-restore');
  assert.equal(service.get(operation.id).grants.length, 1);
  await service.restore(card, operation.id);
  const next = await service.prepare(card, options);
  assert.equal(service.operations.length, 2);
  assert.equal(service.get(operation.id).phase, 'manual-restore');
  assert.equal(service.get(operation.id).grants.length, 0);
  assert.notEqual(next.id, operation.id);
  assert.equal(service.matchOperation({hello: card.state}).id, next.id);
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

test('optional-only maintenance preserves an existing Bundle data recovery reminder', async () => {
  const service = await CardMaintenanceService.create(storageFixture());
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(0x42);
  const options = {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
    selectedOptionalStages: ['security-key'],
  };
  replacement = async () => structuredClone(card.state);
  const original = await service.prepare(card, options);
  await service.replace('session', original.id);
  assert.equal(service.get(original.id).phase, 'manual-restore');
  const optional = await service.prepare(card, {
    ...options,
    replaceStages: ['security-key'],
  });
  assert.equal(service.operations.length, 2);
  await service.replace('session', optional.id);
  assert.equal(service.get(optional.id), undefined);
  assert.equal(service.get(original.id).phase, 'manual-restore');
  assert.equal(
    service.matchOperation({hello: card.state, cardInformation: information})
      .id,
    original.id,
  );
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
      .map(({restored, ...item}) => item),
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

test('an uncertain Import keeps the archive and explicit retry reimports the complete batch', async () => {
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
    [
      hex(sourceItems[0].index),
      hex(sourceItems[1].index),
      ...sourceItems.map(item => hex(item.index)),
    ],
  );
  assert.equal(card.imports[2].key, undefined);
  assert.deepEqual(card.imports[3].key, bytes(''));
  assert.equal(card.imports[3].alias, '');
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

test('bundled maintenance has no self backup and retains a manual recovery reminder', async () => {
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
  replacement = async () => structuredClone(card.state);
  await service.replace('session', operation.id);
  assert.equal(service.get(operation.id).phase, 'manual-restore');
  await assert.rejects(
    service.restore(card, operation.id),
    /no automatic recovery/,
  );
  const restarted = await CardMaintenanceService.create(storage);
  assert.equal(restarted.matchOperation({hello: card.state}).id, operation.id);
});

test('a Bundle reminder is retained during preparation and replaced atomically at the first checkpoint', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(9);
  const options = {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
  };
  const first = await service.prepare(card, options);
  replacement = async () => structuredClone(card.state);
  await service.replace('session', first.id);
  assert.equal(service.get(first.id).phase, 'manual-restore');

  storage.failWrite = true;
  await assert.rejects(service.prepare(card, options), /Disk full/);
  assert.equal(service.get(first.id).phase, 'manual-restore');
  assert.equal((await storage.get()).operations[0].id, first.id);

  storage.failWrite = false;
  const next = await service.prepare(card, options);
  assert.notEqual(next.id, first.id);
  assert.equal(service.get(first.id).phase, 'manual-restore');
  assert.equal(service.operations.length, 2);
  assert.equal(service.matchOperation({hello: card.state}).id, next.id);
  replacement = async (_session, options) => {
    await options.onCheckpoint('remove-monoid-instance');
    assert.equal(service.get(first.id), undefined);
    assert.equal((await storage.get()).operations[0].id, next.id);
    return structuredClone(card.state);
  };
  await service.replace('session', next.id);
  assert.equal(service.operations.length, 1);
  assert.equal(service.get(next.id).phase, 'manual-restore');
});

test('discarding a failed new preparation keeps the previous Bundle recovery reminder', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(9);
  const options = {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
  };
  replacement = async () => structuredClone(card.state);
  const first = await service.prepare(card, options);
  await service.replace('session', first.id);
  const next = await service.prepare(card, options);
  replacement = async () => {
    throw new Error('Preflight failed');
  };
  await assert.rejects(service.replace('session', next.id), /Preflight failed/);
  assert.equal(service.get(next.id), undefined);
  assert.equal(service.get(first.id).phase, 'manual-restore');
  assert.equal(service.matchOperation({hello: card.state}).id, first.id);
  const restarted = await CardMaintenanceService.create(storage);
  assert.equal(restarted.get(first.id).phase, 'manual-restore');
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
  const service = await CardMaintenanceService.create(storageFixture());
  const card = cardFixture();
  card.state.bundle = new Uint8Array(32).fill(9);
  const ordinary = await service.prepare(card, {
    mode: 'reinstall',
    cardInformation: information,
    appletAid: hex(aid),
  });
  replacement = async () => structuredClone(card.state);
  await service.replace('session', ordinary.id);
  const fresh = await service.prepareFresh(information);
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
