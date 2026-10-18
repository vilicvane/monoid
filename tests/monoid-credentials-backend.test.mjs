import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {afterEach, beforeEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

const CONFIG_KEY = 'monoidCredentialsBackend';
const DATA_KEY = 'monoidUnencryptedPINs';
const ENTRY_ID = 'monoid.access-pins';
const CARD_ID = 'a1b2';
const OTHER_CARD_ID = 'c3d4';
const PIN = 'Test PIN 1';
const OTHER_PIN = 'Test PIN 2';
let vault;
let releases;

mock.module('capacitor-biometric-vault', {
  namedExports: {
    BiometricVault: Object.fromEntries(
      ['authenticate', 'clear'].map(method => [
        method,
        (...args) => vault[method](...args),
      ]),
    ),
  },
});

const moduleUrl = new URL(
  '../.bld/app/@services/monoid-credentials-store.js',
  import.meta.url,
);
const environment = registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.startsWith(`${moduleUrl.href}?`)) return loaded;

    const development = new URL(url).search === '?development';
    const source = String(loaded.source);
    assert.ok(source.includes('import.meta.env.DEV'));
    return {
      ...loaded,
      source: source.replaceAll('import.meta.env.DEV', String(development)),
    };
  },
});
const {MonoidCredentialsStore: DevelopmentStore} = await import(
  `${moduleUrl.href}?development`
);
const {MonoidCredentialsStore: ProductionStore} = await import(
  `${moduleUrl.href}?production`
);
environment.deregister();

beforeEach(() => {
  releases = [];
  const values = new Map();
  vault = {
    values,
    authenticate: mock.fn(async () => ({
      get: options => vault.get(options),
      set: options => vault.set(options),
      remove: options => vault.remove(options),
      [Symbol.asyncDispose]: async () => {},
    })),
    get: mock.fn(async ({id}) => ({value: values.get(id) ?? null})),
    set: mock.fn(async ({id, value}) => values.set(id, value)),
    remove: mock.fn(async ({id}) => values.delete(id)),
    clear: mock.fn(async () => values.clear()),
    cancel: mock.fn(async () => {}),
  };
});

afterEach(async () => {
  releases.forEach(resolve => resolve());
  await setImmediate();
});

function storage(config = 'unencrypted') {
  return {
    values: new Map([[CONFIG_KEY, config]]),
    calls: [],
    async get(key) {
      this.calls.push(['get', key]);
      if (this.onGet) return this.onGet(key);
      return this.values.get(key);
    },
    async set(key, value) {
      this.calls.push(['set', key, value]);
      await this.onSet?.(key, value);
      this.values.set(key, value);
    },
    async remove(key) {
      this.calls.push(['remove', key]);
      this.values.delete(key);
    },
  };
}

function deferred() {
  const result = Promise.withResolvers();
  releases.push(result.resolve);
  return result;
}

function assertVaultUnused() {
  for (const method of ['authenticate', 'clear']) {
    assert.equal(vault[method].mock.callCount(), 0, method);
  }
}

test('development uses biometrics unless the exact unencrypted configuration is present', async () => {
  vault.values.set(ENTRY_ID, JSON.stringify({[CARD_ID]: PIN}));
  for (const config of [undefined, 'biometric', 'Unencrypted', true]) {
    const data = storage(config);
    if (config === undefined) data.values.delete(CONFIG_KEY);
    data.values.set(DATA_KEY, JSON.stringify({[OTHER_CARD_ID]: OTHER_PIN}));
    const credentials = await DevelopmentStore.create(data);

    assert.deepEqual(await credentials.getPINs(), {[CARD_ID]: PIN});
    assert.deepEqual(data.calls, [['get', CONFIG_KEY]]);
  }
  assert.equal(vault.get.mock.callCount(), 4);
});

test('production never reads development configuration or plaintext data even when opted in', async () => {
  const data = storage();
  const plaintext = JSON.stringify({[OTHER_CARD_ID]: OTHER_PIN});
  data.values.set(DATA_KEY, plaintext);
  data.onGet = () => {
    throw new Error('Production must not consult ordinary storage');
  };
  vault.values.set(ENTRY_ID, JSON.stringify({[CARD_ID]: PIN}));
  const credentials = await ProductionStore.create(data);

  assert.deepEqual(await credentials.getPINs(), {[CARD_ID]: PIN});
  await credentials.setPIN(OTHER_CARD_ID, OTHER_PIN);
  await credentials.removePIN(CARD_ID);
  await credentials.clear();

  assert.deepEqual(data.calls, []);
  assert.equal(data.values.get(DATA_KEY), plaintext);
  assert.equal(data.values.get(CONFIG_KEY), 'unencrypted');
  assert.equal(vault.clear.mock.callCount(), 1);
});

test('development plaintext persists across instances and CRUD and clear touch only its dedicated key', async () => {
  const data = storage();
  const wallets = [{id: 'wallet-fixture'}];
  data.values.set('walletKeys', wallets);
  data.values.set('monoidPINs', 'legacy-fixture');
  vault.values.set(ENTRY_ID, 'protected-fixture');
  const first = await DevelopmentStore.create(data);
  assert.deepEqual(await first.getPINs(), {});
  await first.setPIN(CARD_ID, PIN);
  const second = await DevelopmentStore.create(data);
  await second.setPIN(OTHER_CARD_ID, OTHER_PIN);

  const snapshot = await first.getPINs();
  assert.deepEqual(snapshot, {[CARD_ID]: PIN, [OTHER_CARD_ID]: OTHER_PIN});
  assert.ok(Object.isFrozen(snapshot));
  assert.equal(typeof data.values.get(DATA_KEY), 'string');
  await second.removePIN(CARD_ID, 'Stale PIN');
  assert.deepEqual(await first.getPINs(), snapshot);
  await second.removePIN(CARD_ID, PIN);
  assert.deepEqual(await first.getPINs(), {[OTHER_CARD_ID]: OTHER_PIN});
  await first.removePIN(OTHER_CARD_ID);
  assert.equal(data.values.has(DATA_KEY), false);
  await first.setPIN(CARD_ID, PIN);
  await second.clear();

  assert.equal(data.values.has(DATA_KEY), false);
  assert.equal(data.values.get(CONFIG_KEY), 'unencrypted');
  assert.equal(data.values.get('walletKeys'), wallets);
  assert.equal(data.values.get('monoidPINs'), 'legacy-fixture');
  assert.equal(vault.values.get(ENTRY_ID), 'protected-fixture');
  assertVaultUnused();
});

test('a corrupt plaintext document permits manual PIN entry but cannot be overwritten by updates', async () => {
  const data = storage();
  const credentials = await DevelopmentStore.create(data);
  for (const value of ['invalid JSON', '[]', '{"a1b2":null}']) {
    data.values.set(DATA_KEY, value);
    assert.deepEqual(await credentials.getPINs(), {});
    await assert.rejects(credentials.setPIN(CARD_ID, PIN), {
      code: 'DATA_CORRUPTED',
    });
    await assert.rejects(credentials.removePIN(CARD_ID), {
      code: 'DATA_CORRUPTED',
    });
    assert.equal(data.values.get(DATA_KEY), value);
  }
  assert.ok(data.calls.every(([method]) => method === 'get'));
  assertVaultUnused();
});

test('plaintext read-modify-write and clear remain serialized across Store instances', async () => {
  const data = storage();
  const first = await DevelopmentStore.create(data);
  const second = await DevelopmentStore.create(data);
  data.calls.length = 0;
  const written = deferred();
  data.onSet = () => written.promise;
  const saving = first.setPIN(CARD_ID, PIN);
  const merging = second.setPIN(OTHER_CARD_ID, OTHER_PIN);
  const reading = second.getPINs();
  const clearing = first.clear();
  await setImmediate();
  assert.deepEqual(
    data.calls.map(([method]) => method),
    ['get', 'set'],
  );
  written.resolve();
  await Promise.all([saving, merging]);
  assert.deepEqual(await reading, {[CARD_ID]: PIN, [OTHER_CARD_ID]: OTHER_PIN});
  await clearing;
  assert.equal(data.values.has(DATA_KEY), false);
  assert.deepEqual(
    data.calls.map(([method]) => method),
    ['get', 'set', 'get', 'set', 'get', 'remove'],
  );
  assertVaultUnused();
});

test('aborted plaintext reads wait for settlement and reject late data before releasing queued work', async () => {
  const data = storage();
  const credentials = await DevelopmentStore.create(data);
  data.calls.length = 0;
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(credentials.getPINs(alreadyAborted.signal), {
    code: 'CANCELLED',
  });
  assert.deepEqual(data.calls, []);

  const loaded = deferred();
  data.onGet = () => loaded.promise;
  const owner = new AbortController();
  const rejected = assert.rejects(credentials.getPINs(owner.signal), {
    code: 'CANCELLED',
  });
  const following = credentials.getPINs();
  await setImmediate();
  owner.abort();
  await setImmediate();
  assert.deepEqual(data.calls, [['get', DATA_KEY]]);
  data.onGet = undefined;
  loaded.resolve(JSON.stringify({[CARD_ID]: PIN}));
  await rejected;
  assert.deepEqual(await following, {});
  assertVaultUnused();
});

test('a committed plaintext write stays successful after abort and queued reads observe it', async () => {
  const data = storage();
  const credentials = await DevelopmentStore.create(data);
  data.calls.length = 0;
  const delivered = deferred();
  data.onSet = async (key, value) => {
    data.values.set(key, value);
    await delivered.promise;
  };
  const owner = new AbortController();
  const saving = credentials.setPIN(CARD_ID, PIN, owner.signal);
  const following = credentials.getPINs();
  await setImmediate();
  owner.abort();
  await setImmediate();
  assert.deepEqual(JSON.parse(data.values.get(DATA_KEY)), {[CARD_ID]: PIN});
  assert.deepEqual(
    data.calls.map(([method]) => method),
    ['get', 'set'],
  );
  delivered.resolve();
  await saving;
  assert.deepEqual(await following, {[CARD_ID]: PIN});
  assertVaultUnused();
});

test('development access disposal waits for pending storage I/O without undoing its commit', async () => {
  const backend = storage();
  const credentials = await DevelopmentStore.create(backend);
  const session = credentials.createPINSession();
  await session.getPINs();
  const commit = deferred();
  backend.onSet = () => commit.promise;
  const saving = session.setPIN(CARD_ID, PIN);
  await setImmediate();
  let disposed = false;
  const closing = session[Symbol.asyncDispose]().then(() => {
    disposed = true;
  });
  await setImmediate();
  assert.equal(disposed, false);
  commit.resolve();
  await Promise.all([saving, closing]);
  assert.deepEqual(JSON.parse(backend.values.get(DATA_KEY)), {[CARD_ID]: PIN});
  assert.equal(disposed, true);
  assertVaultUnused();
});
