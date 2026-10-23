import assert from 'node:assert/strict';
import {beforeEach, mock, test} from 'node:test';

import {encode} from 'cbor2';

let replacement;
let scannedHello;
const bundleHashes = ['identity-image', 'library-image', 'monoid-image'];

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
    getMonoidAppletBundleHashes: () => [...bundleHashes],
    getMonoidAppletBundleHash: stage =>
      bundleHashes[['identity', 'library', 'monoid'].indexOf(stage)],
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
  assert.deepEqual(progress.at(-1), {stage: 'backup', completed: 3, total: 3});
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

test('applet grants stop automatic replacement before any backup or saved operation, including Bundle cards', async () => {
  for (const bundle of [false, new Uint8Array(32).fill(0x42)]) {
    const storage = storageFixture();
    const service = await CardMaintenanceService.create(storage);
    const card = cardFixture();
    card.state.bundle = bundle;
    card.grants = [
      {aid: bytes('a0000006472f0001'), tokenHash: new Uint8Array(32)},
    ];
    for (const mode of ['update', 'reinstall']) {
      await assert.rejects(
        service.prepare(card, {
          mode,
          cardInformation: information,
          appletAid: hex(aid),
        }),
        error =>
          error instanceof MonoidCardError &&
          /Applet grants require separate recovery/.test(error.message),
      );
    }
    assert.deepEqual(card.grantListCalls, [{}, {}]);
    assert.deepEqual(card.listCalls, []);
    assert.deepEqual(card.exports, []);
    assert.equal(storage.writes.length, 0);
    assert.equal(service.operations.length, 0);
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
  card.failImport = 2;
  await assert.rejects(service.restore(card, operation.id), /Tag lost/);
  assert.ok(service.get(operation.id).archive);
  assert.equal(service.get(operation.id).restored, 1);
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
  await assert.rejects(service.restore(card, operation.id), /does not match/);
  assert.equal(service.get(operation.id).archive.items.length, 3);
  await assert.rejects(service.complete(operation.id), /not complete/);
});

test('archive corruption prevents loading saved recovery data', async () => {
  const storage = storageFixture();
  const service = await CardMaintenanceService.create(storage);
  await service.prepare(cardFixture(), {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
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
  await assert.rejects(service.complete(operation.id), /not complete/);
  const restarted = await CardMaintenanceService.create(storage);
  assert.equal(restarted.matchOperation({hello: card.state}).id, operation.id);
});

test('a Bundle reminder is replaced atomically when preparing another maintenance operation', async () => {
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
  assert.equal(service.get(first.id), undefined);
  assert.equal(service.operations.length, 1);
  assert.equal(service.matchOperation({hello: card.state}).id, next.id);
  assert.equal((await storage.get()).operations[0].id, next.id);
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
  assert.equal(service.get(first.id).phase, 'setup');
  await service.complete(first.id);
  assert.equal(service.operations.length, 1);
  assert.equal(service.operations[0].id, second.id);
});

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

test('Fresh stores its new Identity and rejects another card when resuming PIN setup', async () => {
  const service = await CardMaintenanceService.create(storageFixture());
  const original = await service.prepare(cardFixture(), {
    mode: 'update',
    cardInformation: information,
    appletAid: hex(aid),
  });
  const fresh = await service.prepareFresh(information, hello);
  const newHello = {
    ...structuredClone(hello),
    publicKey: bytes(`04${'33'.repeat(64)}`),
  };
  replacement = async () => newHello;
  await service.replace('session', fresh.id);
  assert.equal(service.get(fresh.id).card.publicKey, hex(newHello.publicKey));
  assert.equal(
    service.matchOperation({hello: newHello, cardInformation: information}).id,
    fresh.id,
  );
  await assert.rejects(service.replace('wrong-card', fresh.id), /Wrong card/);
  scannedHello = newHello;
  await service.replace('correct-card', fresh.id);
  await service.complete(fresh.id);
  assert.equal(
    service.matchOperation({hello: newHello, cardInformation: information}),
    undefined,
  );
  assert.ok(service.get(original.id).archive);
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
