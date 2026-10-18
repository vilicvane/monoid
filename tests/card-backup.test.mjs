import assert from 'node:assert/strict';
import {test} from 'node:test';

import {AppletISOError} from '../.bld/app/@lib/applet.js';
import {CBORAppletError} from '../.bld/app/@lib/cbor-applet.js';
import {
  assertBackupCard,
  CardBackupSession,
  getBackupCardIdentity,
  initializeBackupTarget,
} from '../.bld/app/@components/views/safe/@card/card-backup-session.js';

const PIN = 'Safe-42';
const signal = () => new AbortController().signal;
const progress = () => {};
const hex = bytes => Buffer.from(bytes).toString('hex');
const bytes = value => Uint8Array.from(Buffer.from(value, 'hex'));
const index = number => bytes(`1234000000000000000${number}`);

function hello(identity, overrides = {}) {
  return {
    version: 1,
    id: bytes(`0000000${identity}`),
    features: {curves: []},
    pin: 5,
    safe: {
      id: bytes(`1000000${identity}`),
      publicKey: Uint8Array.from([4, ...new Array(64).fill(identity)]),
      pin: 5,
      unlocked: true,
      ...overrides,
    },
  };
}

function destination(identity) {
  return {
    hello: hello(identity),
    calls: [],
    records: new Map(),
    async importItem(request) {
      this.calls.push(['importItem', structuredClone(request)]);
      assert.equal(
        request.data[0],
        identity,
        'Ciphertext belongs to this card',
      );
      await this.beforeImport?.(request);
      const key = hex(request.index);
      const existing = this.records.get(key);
      if (existing) {
        try {
          assert.deepEqual(request, existing);
        } catch {
          throw new AppletISOError(
            'Conflicting item',
            0x6985,
            new Uint8Array(),
          );
        }
      } else {
        this.records.set(key, structuredClone(request));
      }
      await this.afterImport?.(request);
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
      {key: new Uint8Array(), alias: '', data: new Uint8Array(144).fill(2)},
    ],
    [
      hex(index(3)),
      {key: bytes('abcd'), alias: 'e\u0301', data: new Uint8Array(180).fill(3)},
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
    async exportItem(request) {
      this.calls.push(['exportItem', structuredClone(request)]);
      await this.onExport?.(request);
      return artifact(request.index, request.recipientPublicKey);
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

async function ready({multiple = false} = {}) {
  const {source, target, ...rest} = fixture();
  const session = new CardBackupSession();
  await session.readSource(source, source.hello, signal());
  await session.addTarget(target.hello);
  if (multiple) await session.addTarget(rest.secondTarget.hello);
  await session.confirmTargets();
  return {source, target, session, ...rest};
}

function cardSnapshot(source, items) {
  return {
    id: hex(source.hello.safe.id),
    publicKey: hex(source.hello.safe.publicKey),
    items: items.map(item => ({
      index: hex(item.index),
      ...(item.type !== undefined && {type: item.type}),
      ...(item.alias !== undefined && {alias: item.alias}),
      ...(item.key !== undefined && {key: hex(item.key)}),
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
  await session.importItems(target, target.hello, signal(), progress);
  assert.deepEqual(
    source.calls.map(([method]) => method),
    ['authenticate', 'exportItem', 'exportItem'],
  );
  assert.deepEqual([...target.records.keys()], selected);
  assert.equal(session.backup.complete, true);
});

test('copy selection and the scanned Card snapshot do not share mutable item state', async () => {
  const {source, items} = fixture();
  const snapshot = cardSnapshot(source, items);
  snapshot.items[0].key = 'abcd';
  snapshot.items[0].ref = {publicKey: 'public-only', address: 'saved-address'};
  const original = structuredClone(snapshot);
  const session = new CardBackupSession(snapshot, [hex(index(1))]);
  await session.reset(snapshot, [hex(index(2))]);
  assert.deepEqual(snapshot, original);
  assert.equal(Object.hasOwn(session.backup.items[0], 'key'), false);
  assert.equal(Object.hasOwn(session.backup.items[0], 'ref'), false);
  const copy = structuredClone(session.backup);
  snapshot.id = 'ffffffff';
  snapshot.publicKey = hex(hello(3).safe.publicKey);
  snapshot.items[0].alias = 'Changed outside copy';
  snapshot.items[0].secret = false;
  snapshot.items[0].index = hex(index(4));
  snapshot.items.push({index: hex(index(5)), secret: true});
  assert.deepEqual(session.backup, copy);
});

test('snapshot identity is checked with the full public key before the first source authentication', async () => {
  const {source, target, items} = fixture();
  const snapshot = cardSnapshot(source, items);
  const session = new CardBackupSession(snapshot);
  await session.addTarget(target.hello);
  await session.confirmTargets();
  const wrong = hello(3, {id: source.hello.safe.id});
  await assert.rejects(
    session.exportItems(source, wrong, PIN, signal(), progress),
    /Wrong card/i,
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
  await session.importItems(target, target.hello, signal(), progress);
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
  await session.importItems(target, target.hello, signal(), progress);

  assert.equal(session.backup.complete, true);
  assert.equal(session.backup.items.length, 3);
  assert.equal(session.backup.items[1].type, undefined);
  assert.equal(session.backup.items[2].type, 0x1234);
  for (const request of target.records.values()) {
    const exported = artifact(request.index, target.hello.safe.publicKey);
    assert.deepEqual(request, {
      index: request.index,
      senderPublicKey: source.hello.safe.publicKey,
      ...exported,
    });
  }
  assert.equal(
    Object.hasOwn(session.backup.targets[0].items[0].exported, 'alias'),
    false,
  );
  assert.equal(
    Object.hasOwn(session.backup.targets[0].items[0].exported, 'key'),
    false,
  );
  assert.equal(session.backup.targets[0].items[1].exported.alias, '');
  assert.equal(session.backup.targets[0].items[1].exported.key, '');
  assert.equal(session.backup.targets[0].items[2].exported.alias, 'e\u0301');
  assert.equal(JSON.stringify(session.backup).includes(PIN), false);
  assert.deepEqual(
    source.calls.map(([method]) => method),
    ['list', 'authenticate', 'exportItem', 'exportItem', 'exportItem'],
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
  await session.importItems(target, target.hello, signal(), progress);
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
    ['list'],
  );
  await session.removeTarget(hex(target.hello.safe.publicKey));
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
    ['list'],
  );
  await session.readSource(source, source.hello, signal(), [hex(index(1))]);
  await session.addTarget(target.hello);
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  await session.importItems(target, target.hello, signal(), progress);
  assert.deepEqual([...target.records.keys()], [hex(index(1))]);
  assert.equal(session.backup.complete, true);
});

test('same display ID with another public key is rejected before any authentication or import', async () => {
  const {session, source, target} = await ready();
  const wrongSource = hello(3, {id: source.hello.safe.id, unlocked: false});
  assert.throws(
    () => assertBackupCard(wrongSource, session.backup.source),
    /Wrong card/,
  );
  await assert.rejects(
    session.exportItems(source, wrongSource, PIN, signal(), progress),
    /Wrong card/,
  );
  assert.equal(source.calls.length, 1);

  await session.exportItems(source, source.hello, PIN, signal(), progress);
  const wrongTarget = hello(3, {id: target.hello.safe.id});
  await assert.rejects(
    session.importItems(target, wrongTarget, signal(), progress),
    /Wrong card/,
  );
  assert.equal(target.calls.length, 0);
});

test('identity validation rejects invalid, uninitialized, and blocked source or destination cards', async () => {
  assert.throws(
    () => getBackupCardIdentity(hello(1, {publicKey: new Uint8Array(65)})),
    /valid Safe identity/,
  );
  assert.throws(
    () => getBackupCardIdentity(hello(1, {pin: false})),
    /Initialize/,
  );
  assert.throws(
    () => getBackupCardIdentity(hello(1, {unlocked: false})),
    /Initialize/,
  );
  assert.throws(() => getBackupCardIdentity({...hello(1), pin: 0}), /blocked/i);
  assert.throws(() => getBackupCardIdentity(hello(1, {pin: 0})), /blocked/i);
  const {session, source, target} = await ready();
  await assert.rejects(
    session.exportItems(source, hello(1, {pin: 0}), PIN, signal(), progress),
    /blocked/,
  );
  assert.equal(source.calls.length, 1);
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  await assert.rejects(
    session.importItems(target, hello(2, {pin: 0}), signal(), progress),
    /blocked/i,
  );
  await assert.rejects(
    session.importItems(target, {...hello(2), pin: 0}, signal(), progress),
    /blocked/i,
  );
  assert.equal(target.calls.length, 0);
  assert.equal(session.backup.complete, false);
});

function uninitializedTarget({hasSafePIN = false} = {}) {
  const first = {
    ...hello(2, {pin: hasSafePIN ? 5 : false, unlocked: false}),
    pin: false,
  };
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
        return state.result;
      },
    },
  };
  return state;
}

test('a new destination sets only the Safe PIN and verifies initialized Access PIN state with Hello', async () => {
  const state = uninitializedTarget();
  const result = await initializeBackupTarget(
    state.applet,
    state.fresh,
    state.first,
    PIN,
    signal(),
  );

  assert.deepEqual(state.calls, [
    ['setPIN', {safe: true, pin: PIN}],
    ['hello', {safe: true}],
  ]);
  assert.equal(result.pin, 5);
  assert.equal(result.safe.pin, 5);
  assert.equal(result.safe.unlocked, true);
  assert.deepEqual(result.safe.publicKey, state.first.safe.publicKey);
  assert.deepEqual(
    getBackupCardIdentity(result),
    getBackupCardIdentity(state.result),
  );
});

test('restoring an initialized Safe authenticates before setting its PIN to restore Access PIN and unlock state', async () => {
  const state = uninitializedTarget({hasSafePIN: true});
  const result = await initializeBackupTarget(
    state.applet,
    state.fresh,
    state.first,
    PIN,
    signal(),
  );

  assert.deepEqual(state.calls, [
    ['authenticate', {safe: true, pin: PIN}],
    ['setPIN', {safe: true, pin: PIN}],
    ['hello', {safe: true}],
  ]);
  assert.equal(result.pin, 5);
  assert.equal(result.safe.unlocked, true);
});

test('initialization rejects a different full public key before authentication or mutation even with the same display ID', async () => {
  const state = uninitializedTarget({hasSafePIN: true});
  const wrong = hello(3, {id: state.first.safe.id, unlocked: false});
  await assert.rejects(
    initializeBackupTarget(state.applet, wrong, state.first, PIN, signal()),
    /Wrong card/i,
  );
  assert.deepEqual(state.calls, []);
});

test('a Safe PIN configured after the first scan is never overwritten by the initialization flow', async () => {
  const state = uninitializedTarget();
  state.fresh.safe.pin = 5;
  await assert.rejects(
    initializeBackupTarget(
      state.applet,
      state.fresh,
      state.first,
      PIN,
      signal(),
    ),
    /changed|already|again/i,
  );
  assert.deepEqual(state.calls, []);
});

test('an already restored destination returns its fresh ready state without changing its PIN again', async () => {
  const state = uninitializedTarget({hasSafePIN: true});
  const result = await initializeBackupTarget(
    state.applet,
    state.result,
    state.first,
    PIN,
    signal(),
  );
  assert.deepEqual(result, state.result);
  assert.deepEqual(state.calls, []);
});

for (const stopAfter of ['before-start', 'authenticate', 'setPIN']) {
  test(`initialization cancellation after ${stopAfter} starts no later card command`, async () => {
    const state = uninitializedTarget({hasSafePIN: true});
    const controller = new AbortController();
    if (stopAfter === 'before-start') controller.abort();
    else if (stopAfter === 'authenticate')
      state.onAuthenticate = () => controller.abort();
    else state.onSetPIN = () => controller.abort();

    await assert.rejects(
      initializeBackupTarget(
        state.applet,
        state.fresh,
        state.first,
        PIN,
        controller.signal,
      ),
      {code: 'CANCELLED'},
    );
    assert.deepEqual(
      state.calls.map(([method]) => method),
      stopAfter === 'before-start'
        ? []
        : stopAfter === 'authenticate'
          ? ['authenticate']
          : ['authenticate', 'setPIN'],
    );
  });
}

test('incorrect existing Safe PIN is attempted once and never followed by a write', async () => {
  const state = uninitializedTarget({hasSafePIN: true});
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
  'safe-locked',
  'safe-blocked',
  'identity-changed',
]) {
  test(`initialization cannot succeed when final Hello reports ${invalidResult}`, async () => {
    const state = uninitializedTarget();
    if (invalidResult === 'access-unset') state.result.pin = false;
    else if (invalidResult === 'safe-locked')
      state.result.safe.unlocked = false;
    else if (invalidResult === 'safe-blocked') state.result.safe.pin = 0;
    else state.result.safe.publicKey = hello(3).safe.publicKey;

    await assert.rejects(
      initializeBackupTarget(
        state.applet,
        state.fresh,
        state.first,
        PIN,
        signal(),
      ),
      /Initialize|blocked|Wrong card/i,
    );
    assert.deepEqual(
      state.calls.map(([method]) => method),
      ['setPIN', 'hello'],
    );
  });
}

test('wrong Safe PIN is attempted once and never exports or retains the PIN', async () => {
  const {session, source} = await ready();
  await assert.rejects(
    session.exportItems(source, source.hello, 'Wrong-PIN', signal(), progress),
    /4 tries left/,
  );
  assert.deepEqual(
    source.calls.map(([method]) => method),
    ['list', 'authenticate'],
  );
  assert.equal(session.busy, false);
  assert.equal(JSON.stringify(session.backup).includes('Wrong-PIN'), false);
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
      ['exportItem', hex(index(2))],
      ['exportItem', hex(index(3))],
    ],
  );
});

test('lost Import acknowledgement retries the same artifact without re-export or overwrite', async () => {
  const {session, source, target} = await ready();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  target.afterImport = request => {
    if (hex(request.index) === hex(index(2))) throw new Error('Response lost');
  };
  await assert.rejects(
    session.importItems(target, target.hello, signal(), progress),
    /Response lost/,
  );
  assert.equal(session.backup.targets[0].items[0].imported, true);
  assert.equal(session.backup.targets[0].items[1].imported, false);
  const firstAttempt = target.calls.find(
    ([method, request]) =>
      method === 'importItem' && hex(request.index) === hex(index(2)),
  )[1];
  target.afterImport = undefined;
  const start = target.calls.length;
  await session.importItems(target, target.hello, signal(), progress);
  assert.deepEqual(target.calls[start], ['importItem', firstAttempt]);
  assert.equal(target.records.size, 3);
  assert.equal(session.backup.complete, true);
});

test('conflicts preserve target data and allow independent remaining items to finish', async () => {
  const {session, source, target} = await ready();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  const conflicting = {index: index(2), data: bytes('deadbeef')};
  target.records.set(hex(index(2)), conflicting);
  await session.importItems(target, target.hello, signal(), progress);
  assert.equal(session.backup.complete, false);
  assert.equal(session.backup.targets[0].items[1].conflict, true);
  assert.deepEqual(
    session.backup.targets[0].items.map(item => item.imported),
    [true, false, true],
  );
  assert.deepEqual(target.records.get(hex(index(2))), conflicting);
  await session.importItems(target, target.hello, signal(), progress);
  assert.equal(session.backup.targets[0].items[1].conflict, true);
  assert.deepEqual(target.records.get(hex(index(2))), conflicting);
});

test('cancellation after acknowledged Import retains that item and starts no next APDU', async () => {
  const {session, source, target} = await ready();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  const controller = new AbortController();
  target.afterImport = () => controller.abort();
  await assert.rejects(
    session.importItems(target, target.hello, controller.signal, progress),
    {code: 'CANCELLED'},
  );
  assert.equal(target.calls.length, 1);
  assert.deepEqual(
    session.backup.targets[0].items.map(item => item.imported),
    [true, false, false],
  );
});

test('a new page session starts fresh and repeated identical imports preserve existing target items', async () => {
  const {session, source, target} = await ready();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  await session.importItems(target, target.hello, signal(), progress);
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
  await next.importItems(target, target.hello, signal(), progress);

  assert.equal(next.backup.complete, true);
  assert.deepEqual(target.records, existing);
  assert.equal(
    target.calls.filter(([method]) => method === 'importItem').length,
    6,
  );
});

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
      session.removeTarget(hex(target.hello.safe.publicKey)),
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
  await session.removeTarget(hex(secondTarget.hello.safe.publicKey));
  assert.equal(session.backup.targetsConfirmed, false);
  assert.equal(session.backup.targets[0].items.length, 0);
  assert.deepEqual(
    session.backup.items.filter(item => item.selected).map(item => item.index),
    selected,
  );
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  await session.importItems(target, target.hello, signal(), progress);
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
            hex(request.recipientPublicKey) === hex(card.hello.safe.publicKey),
        )
        .map(([, request]) => hex(request.index))
        .sort(),
      [1, 2, 3].map(value => hex(index(value))),
    );
  }
  assert.deepEqual(exportedProgress.at(-1), [6, 6]);
  assert.notEqual(
    session.backup.targets[0].items[0].exported.data,
    session.backup.targets[1].items[0].exported.data,
  );

  const importedProgress = [];
  await session.importItems(
    secondTarget,
    secondTarget.hello,
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
  await session.importItems(target, target.hello, signal(), progress);
  assert.deepEqual(
    session.backup.targets.map(card => card.complete),
    [true, true],
  );
  assert.equal(session.backup.complete, true);
  for (const card of [target, secondTarget]) {
    for (const request of card.records.values()) {
      assert.deepEqual(request, {
        index: request.index,
        senderPublicKey: source.hello.safe.publicKey,
        ...artifact(request.index, card.hello.safe.publicKey),
      });
    }
  }
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
  secondTarget.hello.safe.id = target.hello.safe.id;
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
    ['list'],
  );
  assert.equal(session.backup.targetsConfirmed, false);
});

test('removing a destination before confirmation excludes it from export and import', async () => {
  const {source, target, secondTarget} = fixture();
  const session = new CardBackupSession();
  await session.readSource(source, source.hello, signal());
  await session.addTarget(target.hello);
  await session.addTarget(secondTarget.hello);
  await session.removeTarget(hex(target.hello.safe.publicKey));
  await session.confirmTargets();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  const exports = source.calls.filter(([method]) => method === 'exportItem');
  assert.equal(exports.length, 3);
  assert.ok(
    exports.every(
      ([, request]) =>
        hex(request.recipientPublicKey) ===
        hex(secondTarget.hello.safe.publicKey),
    ),
  );
  await assert.rejects(
    session.importItems(target, target.hello, signal(), progress),
    /Wrong card|destination|added/i,
  );
  assert.equal(target.calls.length, 0);
  await session.importItems(
    secondTarget,
    secondTarget.hello,
    signal(),
    progress,
  );
  assert.equal(session.backup.complete, true);
});

test('an interrupted export for a later destination preserves earlier destination artifacts', async () => {
  const {session, source, target, secondTarget} = await ready({multiple: true});
  source.onExport = request => {
    if (
      hex(request.recipientPublicKey) ===
        hex(secondTarget.hello.safe.publicKey) &&
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
        hex(request.recipientPublicKey) ===
        hex(secondTarget.hello.safe.publicKey),
    ),
  );
  assert.deepEqual(
    session.backup.targets[0].items.map(item => item.exported.data),
    previous,
  );
  await session.importItems(target, target.hello, signal(), progress);
  await session.importItems(
    secondTarget,
    secondTarget.hello,
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
  await session.importItems(target, target.hello, signal(), progress);
  secondTarget.afterImport = request => {
    if (hex(request.index) === hex(index(2))) throw new Error('Response lost');
  };
  await assert.rejects(
    session.importItems(secondTarget, secondTarget.hello, signal(), progress),
    /Response lost/,
  );
  assert.deepEqual(
    session.backup.targets[0].items.map(item => item.imported),
    [true, false, true],
  );
  assert.equal(session.backup.targets[0].items[1].conflict, true);
  assert.deepEqual(
    session.backup.targets[1].items.map(item => item.imported),
    [true, false, false],
  );
  assert.ok(session.backup.targets[1].items.every(item => !item.conflict));
  const firstCardCalls = target.calls.length;
  secondTarget.afterImport = undefined;
  await session.importItems(
    secondTarget,
    secondTarget.hello,
    signal(),
    progress,
  );
  assert.equal(target.calls.length, firstCardCalls);
  assert.deepEqual(target.records.get(hex(index(2))), conflicting);
  assert.deepEqual(
    session.backup.targets.map(card => card.complete),
    [false, true],
  );
  assert.equal(session.backup.complete, false);
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
            hex(request.recipientPublicKey) === hex(card.hello.safe.publicKey),
        )
        .map(([, request]) => hex(request.index))
        .sort(),
      [1, 2, 3].map(value => hex(index(value))),
    );
    await session.importItems(card, card.hello, signal(), progress);
  }
  assert.equal(session.backup.complete, true);
});

test('removing a destination after export clears artifacts and reexports only to the remaining card', async () => {
  const {session, source, target, secondTarget} = await ready({multiple: true});
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  await session.removeTarget(hex(target.hello.safe.publicKey));
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
        hex(request.recipientPublicKey) ===
        hex(secondTarget.hello.safe.publicKey),
    ),
  );
  await assert.rejects(
    session.importItems(target, target.hello, signal(), progress),
    /Wrong card|destination|added/i,
  );
  assert.equal(target.calls.length, 0);
  await session.importItems(
    secondTarget,
    secondTarget.hello,
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
    () => session.removeTarget(hex(hello(4).safe.publicKey)),
  ]) {
    await assert.rejects(operation());
    assert.deepEqual(session.backup, before);
  }
  const sourceCalls = source.calls.length;
  await session.importItems(target, target.hello, signal(), progress);
  assert.equal(source.calls.length, sourceCalls);
  assert.equal(session.backup.complete, true);
});

test('wrong-card and cancelled import preflight leave destinations editable', async () => {
  const {session, source, target, secondTarget} = await ready();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  assert.equal(session.backup.importStarted, false);
  await assert.rejects(
    session.importItems(target, hello(3), signal(), progress),
    /Wrong card|destination|added/i,
  );
  assert.equal(session.backup.importStarted, false);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    session.importItems(target, target.hello, controller.signal, progress),
    {code: 'CANCELLED'},
  );
  assert.equal(target.calls.length, 0);
  assert.equal(session.backup.importStarted, false);
  await session.addTarget(secondTarget.hello);
  await session.removeTarget(hex(target.hello.safe.publicKey));
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
      session.importItems(target, target.hello, signal(), progress),
      /Import response unavailable/,
    );
    assert.equal(target.calls.length, 1);
    assert.equal(
      target.records.size,
      failure === 'before-acknowledgement' ? 0 : 1,
    );
    assert.equal(session.backup.importStarted, true);
    const before = structuredClone(session.backup);
    for (const operation of [
      () => session.addTarget(secondTarget.hello),
      () => session.removeTarget(hex(target.hello.safe.publicKey)),
    ]) {
      await assert.rejects(operation(), /import|started|locked/i);
      assert.deepEqual(session.backup, before);
    }
    const firstArtifact = target.calls[0][1];
    const sourceCalls = source.calls.length;
    target.beforeImport = undefined;
    target.afterImport = undefined;
    await session.importItems(target, target.hello, signal(), progress);
    assert.deepEqual(target.calls[1], ['importItem', firstArtifact]);
    assert.equal(source.calls.length, sourceCalls);
    assert.equal(target.records.size, 3);
    assert.equal(session.backup.complete, true);
  });
}

test('final List must contain all acknowledged items before reporting completion', async () => {
  const {session, source, target} = await ready();
  await session.exportItems(source, source.hello, PIN, signal(), progress);
  target.list = async () => ({items: [{index: index(1)}, {index: index(3)}]});
  await assert.rejects(
    session.importItems(target, target.hello, signal(), progress),
    /not found/,
  );
  assert.equal(session.backup.complete, false);
  assert.deepEqual(
    session.backup.targets[0].items.map(item => item.imported),
    [true, false, true],
  );
});
