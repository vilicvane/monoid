import assert from 'node:assert/strict';
import {afterEach, beforeEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {isOperationCancelled} from '../.bld/app/@lib/operation-cancelled.js';

let vault;
let storage;
let releases;

mock.module('capacitor-biometric-vault', {
  namedExports: {
    BiometricVault: Object.fromEntries(
      ['authenticate', 'clear', 'getAvailability'].map(method => [
        method,
        (...args) => vault[method](...args),
      ]),
    ),
  },
});

mock.module('@ionic/storage', {
  namedExports: {
    Storage: class {
      constructor() {
        this.backend = storage;
      }

      async create() {
        this.backend.calls.push(['create']);
        await this.backend.onCreate?.();
        return this;
      }

      async get(key) {
        this.backend.calls.push(['get', key]);
        return this.backend.values.get(key);
      }

      async set(key, value) {
        this.backend.calls.push(['set', key, value]);
        this.backend.values.set(key, value);
      }

      async remove(key) {
        this.backend.calls.push(['remove', key]);
        await this.backend.onRemove?.(key);
        this.backend.values.delete(key);
      }
    },
  },
});

const {MonoidCredentialsStore} = await import(
  '../.bld/app/@services/monoid-credentials-store.js'
);
const {StorageService} = await import(
  '../.bld/app/@services/storage-service.js'
);

const CARD_ID = 'a1b2c3d4';
const OTHER_CARD_ID = '1020304050';
const ENTRY_ID = 'monoid.access-pins';
const PIN = 'Access 42!';
const SECRET_MARKER = 'DO-NOT-LEAK-SECRET'.repeat(2);

beforeEach(() => {
  releases = [];
  vault = {
    calls: [],
    values: new Map(),
    authentications: [],
    disposals: 0,
    async authenticate(options) {
      this.authentications.push(options);
      const cancel = () => this.calls.push(['close']);
      options.signal?.addEventListener('abort', cancel, {once: true});
      return {
        get: options => this.get(options),
        set: options => this.set(options),
        remove: options => this.remove(options),
        [Symbol.asyncDispose]: async () => {
          options.signal?.removeEventListener('abort', cancel);
          this.disposals++;
        },
      };
    },
    async get(options) {
      this.calls.push(['get', options]);
      if (this.onGet) {
        return this.onGet(options);
      }

      return {value: this.values.get(options.id) ?? null};
    },
    async set(options) {
      this.calls.push(['set', options]);
      await this.onSet?.(options);
      this.values.set(options.id, options.value);
    },
    async remove(options) {
      this.calls.push(['remove', options]);
      await this.onRemove?.(options);
      this.values.delete(options.id);
    },
    async clear() {
      this.calls.push(['clear']);
      await this.onClear?.();
      this.values.clear();
    },
    async getAvailability() {
      this.calls.push(['getAvailability']);
      return {biometrics: 'available'};
    },
    async cancel(options) {
      this.calls.push(['close', options]);
    },
  };
  storage = {calls: [], values: new Map()};
});

afterEach(() => {
  releases.forEach(resolve => resolve());
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  releases.push(resolve);
  return {promise, resolve, reject};
}

function nativeFailure(code, marker = SECRET_MARKER) {
  return Object.assign(new Error(`Native failure included ${marker}`), {
    code,
    cause: new Error(marker),
    data: {value: marker},
  });
}

function assertSanitized(error, code, original) {
  assert.ok(error instanceof Error);
  assert.equal(error.code, code);
  assert.notEqual(error, original);
  assert.ok(error.message.length > 0);
  assert.deepEqual(Object.getOwnPropertyNames(error).sort(), [
    'code',
    'message',
    'stack',
  ]);
  assert.ok(!String(error).includes(SECRET_MARKER));
  assert.ok(!error.stack.includes(SECRET_MARKER));
  assert.ok(!JSON.stringify(error).includes(SECRET_MARKER));
}

function savedPINs() {
  const value = vault.values.get(ENTRY_ID);
  return value === undefined ? {} : JSON.parse(value);
}

function savePINs(pins) {
  vault.values.set(ENTRY_ID, JSON.stringify(pins));
}

test('each bulk read authenticates one fixed entry, awaits completion, and returns an independent snapshot', async () => {
  const credentials = new MonoidCredentialsStore();
  const authenticated = deferred();
  vault.onGet = () => authenticated.promise;
  let settled = false;
  const first = credentials.getPINs().then(value => {
    settled = true;
    return value;
  });
  await setImmediate();
  assert.equal(settled, false);
  assert.equal(vault.calls.length, 1);
  const pins = {[CARD_ID]: PIN, [OTHER_CARD_ID]: 'Other PIN 2'};
  authenticated.resolve({value: JSON.stringify(pins)});
  const snapshot = await first;
  assert.deepEqual(snapshot, pins);
  assert.ok(Object.isFrozen(snapshot));
  vault.onGet = undefined;
  savePINs({[CARD_ID]: 'Next PIN 7'});
  assert.deepEqual(await credentials.getPINs(), {[CARD_ID]: 'Next PIN 7'});
  assert.deepEqual(snapshot, pins);
  vault.values.delete(ENTRY_ID);
  assert.deepEqual(await credentials.getPINs(), {});

  assert.deepEqual(
    vault.calls.map(([method]) => method),
    ['get', 'get', 'get'],
  );
  assert.equal(vault.authentications.length, 3);
  assert.equal(vault.disposals, 3);
  for (const [, options] of vault.calls) {
    assert.deepEqual(options, {id: ENTRY_ID});
  }
  for (const options of vault.authentications) {
    assert.equal(options.reason, 'Unlock Access PINs');
  }
  assert.deepEqual(storage.calls, []);
});

test('old per-card entries are neither read, migrated nor removed', async () => {
  const credentials = new MonoidCredentialsStore();
  const oldId = `monoid.access-pin.${CARD_ID}`;
  vault.values.set(oldId, PIN);
  assert.deepEqual(await credentials.getPINs(), {});
  await credentials.setPIN(OTHER_CARD_ID, PIN);
  assert.equal(vault.values.get(oldId), PIN);
  assert.deepEqual(savedPINs(), {[OTHER_CARD_ID]: PIN});
  assert.ok(vault.calls.every(([, options]) => options.id === ENTRY_ID));
});

test('malformed or invalid maps allow manual entry but can never replace another card credential during updates', async () => {
  const credentials = new MonoidCredentialsStore();
  for (const value of [
    SECRET_MARKER,
    `{"aabb":"${SECRET_MARKER}`,
    'null',
    '[]',
    '42',
    JSON.stringify({[CARD_ID]: PIN, bad: PIN}),
    JSON.stringify({[CARD_ID]: PIN, '': PIN}),
    JSON.stringify({[CARD_ID]: PIN, ABCD: PIN}),
    JSON.stringify({[CARD_ID]: PIN, a: PIN}),
    '{"__proto__":"Access 42!"}',
    JSON.stringify({[CARD_ID]: SECRET_MARKER}),
    JSON.stringify({[CARD_ID]: '12345'}),
    JSON.stringify({[CARD_ID]: '秘密123456'}),
    JSON.stringify({[CARD_ID]: '123456\n'}),
    JSON.stringify({[CARD_ID]: null}),
  ]) {
    vault.values.set(ENTRY_ID, value);
    assert.deepEqual(await credentials.getPINs(), {});
    for (const update of [
      () => credentials.setPIN(CARD_ID, PIN),
      () => credentials.removePIN(CARD_ID),
    ]) {
      await assert.rejects(update(), error => {
        assertSanitized(error, 'DATA_CORRUPTED');
        return true;
      });
    }
    assert.equal(vault.values.get(ENTRY_ID), value);
  }
  assert.ok(vault.calls.every(([method]) => method === 'get'));
  assert.deepEqual(storage.calls, []);
});

test('unavailable or invalidated bulk reads fall back without allowing updates to erase inaccessible credentials', async () => {
  const credentials = new MonoidCredentialsStore();
  savePINs({[OTHER_CARD_ID]: PIN});
  for (const code of [
    'UNSUPPORTED',
    'UNIMPLEMENTED',
    'BIOMETRIC_NOT_ENROLLED',
    'BIOMETRIC_UNAVAILABLE',
    'BIOMETRIC_LOCKED_OUT',
    'HARDWARE_SECURITY_UNAVAILABLE',
    'ENTRY_INVALIDATED',
    'DATA_CORRUPTED',
  ]) {
    const original = nativeFailure(code);
    vault.onGet = async () => {
      throw original;
    };
    assert.deepEqual(await credentials.getPINs(), {}, code);
    for (const update of [
      () => credentials.setPIN(CARD_ID, PIN),
      () => credentials.removePIN(CARD_ID),
    ]) {
      await assert.rejects(update(), error => {
        assertSanitized(
          error,
          code === 'UNIMPLEMENTED' ? 'UNSUPPORTED' : code,
          original,
        );
        return true;
      });
    }
    assert.deepEqual(savedPINs(), {[OTHER_CARD_ID]: PIN});
  }
  assert.ok(vault.calls.every(([method]) => method === 'get'));
  assert.deepEqual(storage.calls, []);
});

test('read cancellation and operational failures remain sanitized rejections', async () => {
  const credentials = new MonoidCredentialsStore();
  for (const code of [
    'CANCELLED',
    'APP_INACTIVE',
    'IO_ERROR',
    'AUTHENTICATION_FAILED',
    'INVALID_ARGUMENT',
  ]) {
    const original = nativeFailure(code);
    vault.onGet = async () => {
      throw original;
    };
    await assert.rejects(credentials.getPINs(), error => {
      assertSanitized(error, code, original);
      return true;
    });
  }
});

test('unknown native failures become a fixed IO error without copying their payload', async () => {
  const credentials = new MonoidCredentialsStore();
  const messages = new Set();
  for (const original of [
    nativeFailure(SECRET_MARKER),
    nativeFailure('constructor'),
    nativeFailure('__proto__'),
    new Error(SECRET_MARKER),
    SECRET_MARKER,
    null,
  ]) {
    vault.onGet = async () => {
      throw original;
    };
    await assert.rejects(credentials.getPINs(), error => {
      assertSanitized(error, 'IO_ERROR', original);
      messages.add(error.message);
      return true;
    });
  }
  assert.equal(messages.size, 1);
});

test('only cancellation and inactive-app errors are treated as cancelled credential requests', () => {
  assert.equal(isOperationCancelled({code: 'CANCELLED'}), true);
  assert.equal(isOperationCancelled({code: 'APP_INACTIVE'}), true);
  for (const error of [
    undefined,
    null,
    'CANCELLED',
    new Error('CANCELLED'),
    {code: 'AUTHENTICATION_FAILED'},
    {code: 'IO_ERROR'},
  ]) {
    assert.equal(isOperationCancelled(error), false);
  }
});

test('an already aborted or queued aborted read never starts native authentication', async () => {
  const credentials = new MonoidCredentialsStore();
  const owner = new AbortController();
  owner.abort(SECRET_MARKER);
  await assert.rejects(credentials.getPINs(owner.signal), {code: 'CANCELLED'});
  assert.deepEqual(vault.calls, []);

  const held = deferred();
  vault.onGet = () => held.promise;
  const first = credentials.getPINs();
  const waitingOwner = new AbortController();
  const waiting = assert.rejects(credentials.getPINs(waitingOwner.signal), {
    code: 'CANCELLED',
  });
  await setImmediate();
  waitingOwner.abort();
  held.resolve({value: null});
  await first;
  await waiting;
  assert.deepEqual(
    vault.calls.map(([method]) => method),
    ['get'],
  );
});

test('aborting an active read closes its scope and rejects a late successful result', async () => {
  const credentials = new MonoidCredentialsStore();
  const authenticated = deferred();
  const owner = new AbortController();
  vault.onGet = () => authenticated.promise;
  const reading = credentials.getPINs(owner.signal);
  const rejected = assert.rejects(reading, error => {
    assertSanitized(error, 'CANCELLED');
    return true;
  });
  await setImmediate();
  owner.abort(SECRET_MARKER);
  assert.deepEqual(vault.calls[1], ['close']);
  authenticated.resolve({value: JSON.stringify({[CARD_ID]: PIN})});
  await rejected;
  vault.onGet = undefined;
  assert.deepEqual(await credentials.getPINs(), {});

  const completedOwner = new AbortController();
  await credentials.getPINs(completedOwner.signal);
  completedOwner.abort();
  assert.equal(vault.calls.filter(([method]) => method === 'close').length, 1);
});

test('aborted queued mutations never start a native read, write, or removal', async () => {
  const credentials = new MonoidCredentialsStore();
  const read = deferred();
  vault.onGet = () => read.promise;
  const first = credentials.getPINs();
  const owner = new AbortController();
  const setting = assert.rejects(
    credentials.setPIN(CARD_ID, PIN, owner.signal),
    {
      code: 'CANCELLED',
    },
  );
  const removing = assert.rejects(
    credentials.removePIN(CARD_ID, PIN, owner.signal),
    {code: 'CANCELLED'},
  );
  await setImmediate();
  owner.abort(SECRET_MARKER);
  read.resolve({value: null});
  await Promise.all([first, setting, removing]);
  assert.deepEqual(
    vault.calls.map(([method]) => method),
    ['get'],
  );
});

for (const mutation of ['set', 'remove']) {
  test(`${mutation}: aborting the merge read waits for native settlement and never begins a write`, async () => {
    const credentials = new MonoidCredentialsStore();
    const before = {[CARD_ID]: PIN, [OTHER_CARD_ID]: 'Other PIN 2'};
    savePINs(before);
    const read = deferred();
    vault.onGet = () => read.promise;
    const owner = new AbortController();
    const changing =
      mutation === 'set'
        ? credentials.setPIN(CARD_ID, 'New PIN 3', owner.signal)
        : credentials.removePIN(CARD_ID, PIN, owner.signal);
    const rejected = assert.rejects(changing, error => {
      assertSanitized(error, 'CANCELLED');
      return true;
    });
    const following = credentials.getPINs();
    await setImmediate();
    owner.abort(SECRET_MARKER);
    await setImmediate();
    assert.deepEqual(
      vault.calls.map(([method]) => method),
      ['get', 'close'],
    );
    assert.deepEqual(vault.calls[1], ['close']);
    vault.onGet = undefined;
    read.resolve({value: JSON.stringify(before)});
    await rejected;
    assert.deepEqual(await following, before);
    assert.deepEqual(savedPINs(), before);
    assert.deepEqual(
      vault.calls.map(([method]) => method),
      ['get', 'close', 'get'],
    );
  });
}

for (const mutation of ['set', 'remove-one', 'remove-final']) {
  test(`${mutation}: abort between a successful merge read and the next stage prevents mutation`, async () => {
    const credentials = new MonoidCredentialsStore();
    const before =
      mutation === 'remove-final'
        ? {[CARD_ID]: PIN}
        : {[CARD_ID]: PIN, [OTHER_CARD_ID]: 'Other PIN 2'};
    savePINs(before);
    const owner = new AbortController();
    vault.onGet = () => ({
      get value() {
        // Run after readPINs validates its result, before the caller's await resumes.
        queueMicrotask(() => owner.abort(SECRET_MARKER));
        return JSON.stringify(before);
      },
    });
    const changing =
      mutation === 'set'
        ? credentials.setPIN(CARD_ID, 'New PIN 3', owner.signal)
        : credentials.removePIN(CARD_ID, PIN, owner.signal);
    await assert.rejects(changing, error => {
      assertSanitized(error, 'CANCELLED');
      return true;
    });
    assert.deepEqual(
      vault.calls.map(([method]) => method),
      ['get', 'close'],
    );
    assert.deepEqual(savedPINs(), before);
  });
}

for (const mutation of ['set', 'remove']) {
  test(`${mutation}: aborting the write closes its scope and keeps later work queued until native settles`, async () => {
    const credentials = new MonoidCredentialsStore();
    const before = {[CARD_ID]: PIN, [OTHER_CARD_ID]: 'Other PIN 2'};
    savePINs(before);
    const write = deferred();
    vault.onSet = () => write.promise;
    const owner = new AbortController();
    const changing =
      mutation === 'set'
        ? credentials.setPIN(CARD_ID, 'New PIN 3', owner.signal)
        : credentials.removePIN(CARD_ID, PIN, owner.signal);
    const rejected = assert.rejects(changing, error => {
      assertSanitized(error, 'CANCELLED');
      return true;
    });
    const following = credentials.getPINs();
    await setImmediate();
    assert.equal(vault.authentications.length, 1);
    owner.abort(SECRET_MARKER);
    await setImmediate();
    assert.deepEqual(
      vault.calls.map(([method]) => method),
      ['get', 'set', 'close'],
    );
    assert.deepEqual(vault.calls[2], ['close']);
    write.reject(nativeFailure('CANCELLED'));
    await rejected;
    assert.deepEqual(await following, before);
    assert.deepEqual(savedPINs(), before);
  });
}

test('a committed write remains successful after abort and the next queued read observes it', async () => {
  const credentials = new MonoidCredentialsStore();
  savePINs({[CARD_ID]: 'Old PIN 1'});
  const delivered = deferred();
  vault.onSet = async options => {
    // The commit happened; only delivery of the native result is delayed.
    vault.values.set(options.id, options.value);
    await delivered.promise;
  };
  const owner = new AbortController();
  const saving = credentials.setPIN(CARD_ID, PIN, owner.signal);
  const following = credentials.getPINs();
  await setImmediate();
  assert.deepEqual(savedPINs(), {[CARD_ID]: PIN});
  owner.abort(SECRET_MARKER);
  assert.deepEqual(vault.calls[2], ['close']);
  delivered.resolve();
  await saving;
  assert.deepEqual(await following, {[CARD_ID]: PIN});

  vault.onSet = undefined;
  const completedOwner = new AbortController();
  await credentials.setPIN(CARD_ID, PIN, completedOwner.signal);
  completedOwner.abort();
  assert.equal(vault.calls.filter(([method]) => method === 'close').length, 1);
});

test('a committed final-entry removal remains successful when its owner aborts', async () => {
  const credentials = new MonoidCredentialsStore();
  savePINs({[CARD_ID]: PIN});
  const removed = deferred();
  vault.onRemove = options => {
    vault.values.delete(options.id);
    return removed.promise;
  };
  const owner = new AbortController();
  const removing = credentials.removePIN(CARD_ID, PIN, owner.signal);
  const following = credentials.getPINs();
  await setImmediate();
  owner.abort(SECRET_MARKER);
  assert.deepEqual(
    vault.calls.map(([method]) => method),
    ['get', 'remove', 'close'],
  );
  removed.resolve();
  await removing;
  assert.deepEqual(await following, {});
  assert.deepEqual(
    vault.calls.map(([method]) => method),
    ['get', 'remove', 'close', 'get'],
  );
});

test('read-modify-write operations serialize across Store instances and preserve concurrent card updates', async () => {
  const firstStore = new MonoidCredentialsStore();
  const secondStore = new MonoidCredentialsStore();
  savePINs({[CARD_ID]: 'Old PIN 1', ff: 'Remove me'});
  const committed = deferred();
  vault.onSet = () => committed.promise;
  const first = firstStore.setPIN(CARD_ID, PIN);
  const second = secondStore.setPIN(OTHER_CARD_ID, 'Other PIN 2');
  const removal = firstStore.removePIN('ff');
  const reading = secondStore.getPINs();
  await setImmediate();
  assert.deepEqual(
    vault.calls.map(([method]) => method),
    ['get', 'set'],
  );
  assert.deepEqual(savedPINs(), {[CARD_ID]: 'Old PIN 1', ff: 'Remove me'});
  committed.resolve();
  await Promise.all([first, second, removal]);
  assert.deepEqual(await reading, {
    [CARD_ID]: PIN,
    [OTHER_CARD_ID]: 'Other PIN 2',
  });
  assert.deepEqual(
    vault.calls.map(([method]) => method),
    ['get', 'set', 'get', 'set', 'get', 'set', 'get'],
  );
  assert.equal(vault.authentications.length, 4);
  assert.equal(vault.disposals, 4);
  assert.deepEqual(storage.calls, []);
});

test('invalid incoming card IDs and PINs reject before any native secret operation', async () => {
  const credentials = new MonoidCredentialsStore();
  for (const pin of [
    '',
    '12345',
    'x'.repeat(33),
    '秘密123456',
    SECRET_MARKER,
    null,
    123456,
  ]) {
    await assert.rejects(credentials.setPIN(CARD_ID, pin), {
      code: 'INVALID_ARGUMENT',
    });
    await assert.rejects(credentials.removePIN(CARD_ID, pin), {
      code: 'INVALID_ARGUMENT',
    });
  }
  for (const id of ['', 'a', 'ABCD', 'hello', '__proto__', null, 12]) {
    await assert.rejects(credentials.setPIN(id, PIN), {
      code: 'INVALID_ARGUMENT',
    });
    await assert.rejects(credentials.removePIN(id), {code: 'INVALID_ARGUMENT'});
  }
  assert.deepEqual(vault.calls, []);
  assert.deepEqual(storage.calls, []);
});

test('a failed save preserves all previous cards, exposes no native payload, and does not block queued updates', async () => {
  const credentials = new MonoidCredentialsStore();
  savePINs({[OTHER_CARD_ID]: 'Other PIN 2'});
  const original = nativeFailure('IO_ERROR');
  let writes = 0;
  vault.onSet = async () => {
    if (writes++ === 0) throw original;
  };
  const failure = assert.rejects(credentials.setPIN(CARD_ID, PIN), error => {
    assertSanitized(error, 'IO_ERROR', original);
    assert.deepEqual(savedPINs(), {[OTHER_CARD_ID]: 'Other PIN 2'});
    return true;
  });
  const next = credentials.setPIN('aa', PIN);
  await failure;
  await next;
  assert.deepEqual(savedPINs(), {[OTHER_CARD_ID]: 'Other PIN 2', aa: PIN});
  assert.deepEqual(storage.calls, []);
});

test('removal preserves other cards, deletes the final record, and does nothing for a missing card', async () => {
  const credentials = new MonoidCredentialsStore();
  savePINs({[CARD_ID]: PIN, [OTHER_CARD_ID]: 'Other PIN 2'});
  await credentials.removePIN(CARD_ID);
  assert.deepEqual(savedPINs(), {[OTHER_CARD_ID]: 'Other PIN 2'});
  await credentials.removePIN(OTHER_CARD_ID);
  assert.equal(vault.values.has(ENTRY_ID), false);
  await credentials.removePIN(CARD_ID);
  assert.deepEqual(
    vault.calls.map(([method]) => method),
    ['get', 'set', 'get', 'remove', 'get'],
  );
  assert.deepEqual(vault.calls[3], ['remove', {id: ENTRY_ID}]);
});

test('conditional removal from an old snapshot cannot delete a queued replacement from another Store', async () => {
  const scanningStore = new MonoidCredentialsStore();
  const updatingStore = new MonoidCredentialsStore();
  savePINs({[CARD_ID]: 'Old PIN 1', [OTHER_CARD_ID]: PIN});
  const scannedPINs = await scanningStore.getPINs();
  const committed = deferred();
  vault.onSet = () => committed.promise;
  const updating = updatingStore.setPIN(CARD_ID, 'New PIN 2');
  const removing = scanningStore.removePIN(CARD_ID, scannedPINs[CARD_ID]);
  await setImmediate();
  assert.deepEqual(
    vault.calls.map(([method]) => method),
    ['get', 'get', 'set'],
  );
  committed.resolve();
  await Promise.all([updating, removing]);
  assert.deepEqual(savedPINs(), {[CARD_ID]: 'New PIN 2', [OTHER_CARD_ID]: PIN});
  assert.deepEqual(
    vault.calls.map(([method]) => method),
    ['get', 'get', 'set', 'get'],
  );

  await scanningStore.removePIN(OTHER_CARD_ID, scannedPINs[OTHER_CARD_ID]);
  assert.deepEqual(savedPINs(), {[CARD_ID]: 'New PIN 2'});
  await scanningStore.removePIN(CARD_ID, 'New PIN 2');
  assert.equal(vault.values.has(ENTRY_ID), false);
});

test('final-record removal failures retain a sanitized error and the queue remains usable', async () => {
  const credentials = new MonoidCredentialsStore();
  savePINs({[CARD_ID]: PIN});
  const original = nativeFailure('IO_ERROR');
  vault.onRemove = async () => {
    throw original;
  };
  await assert.rejects(credentials.removePIN(CARD_ID), error => {
    assertSanitized(error, 'IO_ERROR', original);
    return true;
  });
  assert.deepEqual(await credentials.getPINs(), {[CARD_ID]: PIN});
});

test('clear is ordered between writes so a completed earlier merge cannot recreate cleared cards', async () => {
  const credentials = new MonoidCredentialsStore();
  const committed = deferred();
  vault.onSet = () => committed.promise;
  const first = credentials.setPIN(CARD_ID, PIN);
  const clearing = credentials.clear();
  const next = credentials.setPIN(OTHER_CARD_ID, 'Other PIN 2');
  await setImmediate();
  assert.deepEqual(
    vault.calls.map(([method]) => method),
    ['get', 'set'],
  );
  committed.resolve();
  await Promise.all([first, clearing, next]);
  assert.deepEqual(savedPINs(), {[OTHER_CARD_ID]: 'Other PIN 2'});
  assert.deepEqual(
    vault.calls.map(([method]) => method),
    ['get', 'set', 'clear', 'get', 'set'],
  );
});

test('clear waits for native completion, can repeat, and only clears protected storage without reading secrets', async () => {
  const credentials = new MonoidCredentialsStore();
  const cleared = deferred();
  const wallets = [{id: 'wallet-fixture'}];
  const monoids = [{id: CARD_ID}];
  storage.values.set('wallets', wallets);
  storage.values.set('monoids', monoids);
  savePINs({[CARD_ID]: PIN});
  vault.values.set('another-vault-entry', SECRET_MARKER);
  vault.onClear = () => cleared.promise;
  let settled = false;
  const clearing = credentials.clear().then(() => {
    settled = true;
  });
  await setImmediate();
  assert.equal(settled, false);
  assert.equal(vault.values.size, 2);
  assert.deepEqual(vault.calls, [['clear']]);
  cleared.resolve();
  await clearing;
  assert.equal(settled, true);
  assert.equal(vault.values.size, 0);
  await credentials.clear();
  assert.deepEqual(vault.calls, [['clear'], ['clear']]);
  assert.equal(storage.values.get('wallets'), wallets);
  assert.equal(storage.values.get('monoids'), monoids);
  assert.deepEqual(storage.calls, []);
});

test('clear failure rejects without leaking native details or falling back to other storage', async () => {
  const credentials = new MonoidCredentialsStore();
  const original = nativeFailure('IO_ERROR');
  savePINs({[CARD_ID]: PIN});
  vault.onClear = async () => {
    throw original;
  };
  await assert.rejects(credentials.clear(), error => {
    assertSanitized(error, 'IO_ERROR', original);
    return true;
  });
  assert.deepEqual(vault.calls, [['clear']]);
  assert.deepEqual(storage.calls, []);
});

test('storage initialization removes legacy PINs and backup progress while preserving other data', async () => {
  const created = deferred();
  const cleaned = deferred();
  const wallets = [{id: 'wallet-fixture'}];
  const monoids = [{id: CARD_ID}];
  storage.values.set('monoidPINs', {[CARD_ID]: PIN});
  storage.values.set('cardBackup', {items: []});
  storage.values.set('wallets', wallets);
  storage.values.set('monoids', monoids);
  storage.onCreate = () => created.promise;
  storage.onRemove = () => cleaned.promise;
  let settled = false;
  const initializing = StorageService.create().then(service => {
    settled = true;
    return service;
  });
  await setImmediate();

  assert.deepEqual(storage.calls, [['create']]);
  assert.equal(settled, false);
  created.resolve();
  await setImmediate();
  assert.deepEqual(storage.calls, [['create'], ['remove', 'monoidPINs']]);
  assert.equal(settled, false);
  cleaned.resolve();
  const service = await initializing;
  assert.equal(storage.values.has('monoidPINs'), false);
  assert.equal(storage.values.has('cardBackup'), false);
  assert.equal(storage.values.get('wallets'), wallets);
  assert.equal(storage.values.get('monoids'), monoids);
  assert.equal(await service.get('wallets'), wallets);
  assert.deepEqual(vault.calls, []);
});

test('a failed legacy cleanup prevents storage initialization from reporting success', async () => {
  storage.values.set('monoidPINs', {[CARD_ID]: PIN});
  storage.onRemove = async () => {
    throw new Error('Legacy cleanup failed');
  };
  await assert.rejects(StorageService.create(), /Legacy cleanup failed/);
  assert.deepEqual(storage.calls, [['create'], ['remove', 'monoidPINs']]);
  assert.equal(storage.values.has('monoidPINs'), true);
  assert.deepEqual(vault.calls, []);
});

test('a failed storage creation does not run cleanup or migrate credentials', async () => {
  storage.onCreate = async () => {
    throw new Error('Storage creation failed');
  };
  await assert.rejects(StorageService.create(), /Storage creation failed/);
  assert.deepEqual(storage.calls, [['create']]);
  assert.deepEqual(vault.calls, []);
});
