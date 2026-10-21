import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {createContext, runInContext} from 'node:vm';

import ts from 'typescript';

// eslint-disable-next-line import/no-relative-packages -- Exercise the private wrapper with a native mock, without registering Capacitor.
import {createBiometricVault} from '../plugins/biometric-vault/dist/esm/access.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {promise, resolve, reject};
}

function vaultError(code) {
  return Object.assign(new Error(code), {code});
}

function mockNative(overrides = {}) {
  const calls = [];
  const values = new Map();
  const implementations = {
    async getAvailability() {
      return {biometrics: 'available'};
    },
    async authenticate() {
      return {accessId: 'native-access'};
    },
    async closeAccess() {},
    async get({id}) {
      return {value: values.get(id) ?? null};
    },
    async set({id, value}) {
      values.set(id, value);
    },
    async remove({id}) {
      values.delete(id);
    },
    async clear() {
      values.clear();
    },
    async cancel() {},
    ...overrides,
  };
  const native = Object.fromEntries(
    Object.entries(implementations).map(([method, implementation]) => [
      method,
      (...args) => {
        calls.push([method, ...args]);
        return implementation(...args);
      },
    ]),
  );

  return {vault: createBiometricVault(native), calls, values};
}

test('one authentication supplies scoped CRUD while bridge IDs remain internal', async () => {
  const {vault, calls, values} = mockNative();
  const access = await vault.authenticate({reason: 'Update secrets'});

  assert.deepEqual(Object.keys(vault).sort(), [
    'authenticate',
    'clear',
    'getAvailability',
    'remove',
  ]);
  assert.deepEqual(Object.keys(access).sort(), ['get', 'remove', 'set']);
  assert.deepEqual(await access.get({id: 'entry'}), {value: null});
  await access.set({id: 'entry', value: 'value'});
  assert.equal(values.get('entry'), 'value');
  await access.remove({id: 'entry'});
  assert.equal(values.has('entry'), false);
  await access[Symbol.asyncDispose]();

  assert.deepEqual(
    calls.map(([method]) => method),
    ['authenticate', 'get', 'set', 'remove', 'closeAccess'],
  );
  const requestIds = calls.slice(0, 4).map(([, options]) => options.requestId);
  assert.equal(new Set(requestIds).size, requestIds.length);

  for (const [, options] of calls.slice(1, 4)) {
    assert.equal(options.accessId, 'native-access');
    assert.equal('reason' in options, false);
  }
});

test('global availability and deletion require no access', async () => {
  const {vault, calls} = mockNative();
  assert.deepEqual(await vault.getAvailability(), {biometrics: 'available'});
  await vault.remove({id: 'entry'});
  await vault.clear();
  assert.deepEqual(calls, [
    ['getAvailability'],
    ['remove', {id: 'entry'}],
    ['clear'],
  ]);
});

test('an already aborted signal never opens a native prompt', async () => {
  const controller = new AbortController();
  controller.abort();
  const {vault, calls} = mockNative();

  await assert.rejects(
    vault.authenticate({reason: 'Read', signal: controller.signal}),
    {code: 'CANCELLED'},
  );
  assert.deepEqual(calls, []);
});

test('aborting authentication cancels its request and closes a late successful access', async () => {
  const authentication = deferred();
  const cleanup = deferred();
  const controller = new AbortController();
  const {vault, calls} = mockNative({
    authenticate: () => authentication.promise,
    closeAccess: () => cleanup.promise,
  });
  const result = vault.authenticate({
    reason: 'Read',
    signal: controller.signal,
  });
  const rejected = assert.rejects(result, {code: 'CANCELLED'});
  let settled = false;
  void rejected.then(() => (settled = true));

  controller.abort();
  assert.equal(calls[1][0], 'cancel');
  assert.equal(calls[1][1].requestId, calls[0][1].requestId);
  authentication.resolve({accessId: 'late-access'});
  await setImmediate();
  assert.deepEqual(calls.at(-1), ['closeAccess', {accessId: 'late-access'}]);
  assert.equal(settled, false);

  cleanup.resolve();
  await rejected;
});

test('cancel failure cannot leak a late successful access', async () => {
  const authentication = deferred();
  const controller = new AbortController();
  const failure = vaultError('IO_ERROR');
  const {vault, calls} = mockNative({
    authenticate: () => authentication.promise,
    cancel: async () => {
      throw failure;
    },
  });
  const result = vault.authenticate({
    reason: 'Read',
    signal: controller.signal,
  });
  const rejected = assert.rejects(result, error => error === failure);

  controller.abort();
  authentication.resolve({accessId: 'late-access'});
  await rejected;
  assert.deepEqual(calls.at(-1), ['closeAccess', {accessId: 'late-access'}]);
});

test('failed authentication waits for native cancellation cleanup', async () => {
  const authentication = deferred();
  const cancellation = deferred();
  const controller = new AbortController();
  const {vault, calls} = mockNative({
    authenticate: () => authentication.promise,
    cancel: () => cancellation.promise,
  });
  const result = vault.authenticate({
    reason: 'Read',
    signal: controller.signal,
  });
  const rejected = assert.rejects(result, {code: 'CANCELLED'});
  let settled = false;
  void rejected.then(() => (settled = true));

  controller.abort();
  authentication.reject(vaultError('CANCELLED'));
  await setImmediate();
  assert.equal(settled, false);
  cancellation.resolve();
  await rejected;
  assert.equal(
    calls.some(([method]) => method === 'closeAccess'),
    false,
  );
});

test('abort remains active after authentication and disposal awaits the same cleanup', async () => {
  const cleanup = deferred();
  const controller = new AbortController();
  const {vault, calls} = mockNative({closeAccess: () => cleanup.promise});
  const access = await vault.authenticate({
    reason: 'Read',
    signal: controller.signal,
  });

  controller.abort();
  assert.equal(calls.at(-1)[0], 'closeAccess');
  await assert.rejects(access.get({id: 'entry'}), {code: 'CANCELLED'});
  const firstDisposal = access[Symbol.asyncDispose]();
  assert.equal(firstDisposal, access[Symbol.asyncDispose]());
  let settled = false;
  void firstDisposal.then(() => (settled = true));
  await setImmediate();
  assert.equal(settled, false);

  cleanup.resolve();
  await firstDisposal;
  assert.equal(calls.filter(([method]) => method === 'closeAccess').length, 1);
});

test('disposal immediately rejects new calls and waits for a pending operation to settle', async () => {
  const writing = deferred();
  const {vault, calls} = mockNative({set: () => writing.promise});
  const access = await vault.authenticate({reason: 'Write'});
  const writeResult = access.set({id: 'entry', value: 'value'});
  const writeRejected = assert.rejects(writeResult, {code: 'ACCESS_CLOSED'});
  const disposal = access[Symbol.asyncDispose]();
  let disposed = false;
  void disposal.then(() => (disposed = true));

  await assert.rejects(access.get({id: 'entry'}), {code: 'ACCESS_CLOSED'});
  await assert.rejects(access.set({id: 'entry', value: 'other'}), {
    code: 'ACCESS_CLOSED',
  });
  await assert.rejects(access.remove({id: 'entry'}), {code: 'ACCESS_CLOSED'});
  await setImmediate();
  assert.equal(disposed, false);
  assert.deepEqual(
    calls.map(([method]) => method),
    ['authenticate', 'set', 'closeAccess'],
  );

  writing.reject(vaultError('ACCESS_CLOSED'));
  await Promise.all([writeRejected, disposal]);
});

test('an already committed write keeps its successful result after abort', async () => {
  const completion = deferred();
  const controller = new AbortController();
  let committed = false;
  const {vault} = mockNative({
    set: async () => {
      committed = true;
      await completion.promise;
    },
  });
  const access = await vault.authenticate({
    reason: 'Write',
    signal: controller.signal,
  });
  const writeResult = access.set({id: 'entry', value: 'value'});
  assert.equal(committed, true);
  controller.abort();
  const disposal = access[Symbol.asyncDispose]();
  completion.resolve();
  await writeResult;
  await disposal;
});

test('expiration closes access without retrying authentication', async () => {
  const {vault, calls} = mockNative({
    get: async () => {
      throw vaultError('AUTHORIZATION_EXPIRED');
    },
  });
  const access = await vault.authenticate({reason: 'Read'});

  await assert.rejects(access.get({id: 'entry'}), {
    code: 'AUTHORIZATION_EXPIRED',
  });
  await assert.rejects(access.set({id: 'entry', value: 'value'}), {
    code: 'AUTHORIZATION_EXPIRED',
  });
  await access[Symbol.asyncDispose]();
  assert.deepEqual(
    calls.map(([method]) => method),
    ['authenticate', 'get', 'closeAccess'],
  );
});

test('operation failures propagate to their caller without being repeated at disposal', async () => {
  const failure = vaultError('DATA_CORRUPTED');
  const {vault} = mockNative({
    get: async () => {
      throw failure;
    },
  });
  const access = await vault.authenticate({reason: 'Read'});

  await assert.rejects(access.get({id: 'entry'}), error => error === failure);
  await access[Symbol.asyncDispose]();
});

test('cleanup failure propagates after pending operations settle, including a background abort', async () => {
  const writing = deferred();
  const failure = vaultError('IO_ERROR');
  const controller = new AbortController();
  const {vault} = mockNative({
    set: () => writing.promise,
    closeAccess: async () => {
      throw failure;
    },
  });
  const access = await vault.authenticate({
    reason: 'Write',
    signal: controller.signal,
  });
  const writeResult = access.set({id: 'entry', value: 'value'});
  controller.abort();
  const rejected = assert.rejects(
    access[Symbol.asyncDispose](),
    error => error === failure,
  );
  let settled = false;
  void rejected.then(() => (settled = true));
  await setImmediate();
  assert.equal(settled, false);
  writing.resolve();
  await Promise.all([writeResult, rejected]);
});

test('disposal succeeds when native access has already expired or closed', async () => {
  for (const code of [
    'CANCELLED',
    'ACCESS_CLOSED',
    'AUTHORIZATION_EXPIRED',
    'APP_INACTIVE',
  ]) {
    const {vault} = mockNative({
      closeAccess: async () => {
        throw vaultError(code);
      },
    });
    const access = await vault.authenticate({reason: 'Read'});
    await access[Symbol.asyncDispose]();
  }
});

const {outputText} = ts.transpileModule(
  `export async function run(vault, body) {
    await using access = await vault.authenticate({reason: 'Read'});
    return await body(access);
  }`,
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2018,
      module: ts.ModuleKind.ESNext,
    },
  },
);
const {run: runUsing} = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

test('transpiled await using waits for cleanup before returning', async () => {
  const cleanup = deferred();
  const {vault, calls} = mockNative({closeAccess: () => cleanup.promise});
  let retainedAccess;
  const result = runUsing(vault, access => {
    retainedAccess = access;
    return 'result';
  });
  let settled = false;
  void result.then(() => (settled = true));

  await setImmediate();
  assert.equal(calls.at(-1)[0], 'closeAccess');
  assert.equal(settled, false);
  await assert.rejects(retainedAccess.get({id: 'entry'}), {
    code: 'ACCESS_CLOSED',
  });
  cleanup.resolve();
  assert.equal(await result, 'result');
});

test('transpiled await using disposes when its body throws', async () => {
  const {vault, calls} = mockNative();
  const failure = new Error('Business flow failed');
  await assert.rejects(
    runUsing(vault, async () => {
      throw failure;
    }),
    error => error === failure,
  );
  assert.equal(calls.at(-1)[0], 'closeAccess');
});

test('older runtimes receive the async disposal symbol needed by transpiled using', async () => {
  const source = await readFile(
    new URL('../plugins/biometric-vault/dist/esm/access.js', import.meta.url),
    'utf8',
  );
  const legacySymbol = description => Symbol(description);
  const context = createContext({exports: {}, Symbol: legacySymbol});
  const {outputText: commonJS} = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2018,
      module: ts.ModuleKind.CommonJS,
    },
  });

  assert.equal(legacySymbol.asyncDispose, undefined);
  runInContext(commonJS, context);
  const createLegacyVault = context.exports.createBiometricVault;
  const disposalSymbol = legacySymbol.asyncDispose;
  assert.equal(typeof disposalSymbol, 'symbol');

  let closed = false;
  const vault = createLegacyVault({
    authenticate: async () => ({accessId: 'legacy-access'}),
    closeAccess: async () => {
      closed = true;
    },
  });
  const {outputText: usingCommonJS} = ts.transpileModule(outputText, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2018,
      module: ts.ModuleKind.CommonJS,
    },
  });
  context.exports = {};
  runInContext(usingCommonJS, context);

  assert.equal(await context.exports.run(vault, () => 'done'), 'done');
  assert.equal(closed, true);
});
