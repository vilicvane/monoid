import assert from 'node:assert/strict';
import {beforeEach, mock, test} from 'node:test';

import {AppletISOError, AppletNotFoundError} from '../.bld/app/@lib/applet.js';

let fixture;

mock.module('../.bld/app/@lib/monoid/install.js', {
  namedExports: {
    installMonoidApplets: async (sessionId, onProgress, signal) => {
      fixture.installs.push(sessionId);
      assert.equal(signal, fixture.controller.signal);
      if (fixture.installError) throw fixture.installError;
      for (const update of fixture.updates) onProgress(update);
      return fixture.hello;
    },
  },
});

const {readCopyDestination} = await import(
  '../.bld/app/@components/views/safe/@card/read-copy-destination.js'
);

beforeEach(() => {
  fixture = {
    controller: new AbortController(),
    sessions: [],
    installs: [],
    hellos: [],
    updates: [],
    hello: {
      version: 1,
      id: Uint8Array.of(1, 2, 3, 4),
      pin: false,
      features: {curves: []},
      safe: {
        id: Uint8Array.of(5, 6, 7, 8),
        publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(7)),
        pin: false,
        unlocked: false,
      },
    },
    applet: {
      async openSession(sessionId) {
        fixture.sessions.push(sessionId);
        if (fixture.selectPending) await fixture.selectPending.promise;
        if (fixture.selectError) throw fixture.selectError;
        return {
          async hello(request) {
            fixture.hellos.push(request);
            if (fixture.helloPending) await fixture.helloPending.promise;
            if (fixture.helloError) throw fixture.helloError;
            return fixture.hello;
          },
        };
      },
    },
  };
});

test('an installed destination reads Safe metadata without installing anything', async () => {
  const hello = await readCopyDestination(
    'destination',
    fixture.applet,
    () => assert.fail('Unexpected installation progress'),
    fixture.controller.signal,
  );

  assert.deepEqual(hello, fixture.hello);
  assert.deepEqual(fixture.sessions, ['destination']);
  assert.deepEqual(fixture.hellos, [{safe: true}]);
  assert.deepEqual(fixture.installs, []);
});

test('a missing Monoid applet installs in the same NFC session and returns the verified hello', async () => {
  fixture.selectError = new AppletNotFoundError(new Uint8Array());
  fixture.updates = [
    {stage: 'identity', phase: 'uploading', progress: 0.4},
    {stage: 'identity', phase: 'configuring'},
    {stage: 'verifying'},
  ];
  const updates = [];
  const hello = await readCopyDestination(
    'destination',
    fixture.applet,
    update => updates.push(update),
    fixture.controller.signal,
  );

  assert.equal(hello, fixture.hello);
  assert.deepEqual(fixture.sessions, ['destination']);
  assert.deepEqual(fixture.installs, ['destination']);
  assert.deepEqual(fixture.hellos, []);
  assert.deepEqual(updates, fixture.updates);
});

for (const error of [
  new AppletISOError('Selection failed', 0x6999, new Uint8Array()),
  Object.assign(new Error('Card lost'), {code: 'TAG_LOST'}),
]) {
  test(`a SELECT ${error.code ?? error.sw.toString(16)} failure does not install`, async () => {
    fixture.selectError = error;

    await assert.rejects(
      readCopyDestination(
        'destination',
        fixture.applet,
        () => {},
        fixture.controller.signal,
      ),
      value => value === error,
    );
    assert.deepEqual(fixture.installs, []);
    assert.deepEqual(fixture.hellos, []);
  });
}

test('a hello error never triggers applet installation, even if it reports a missing applet', async () => {
  fixture.helloError = new AppletNotFoundError(new Uint8Array());

  await assert.rejects(
    readCopyDestination(
      'destination',
      fixture.applet,
      () => {},
      fixture.controller.signal,
    ),
    error => error === fixture.helloError,
  );
  assert.deepEqual(fixture.installs, []);
});

test('invalid Safe metadata is rejected without trying to install', async () => {
  delete fixture.hello.safe;

  await assert.rejects(
    readCopyDestination(
      'destination',
      fixture.applet,
      () => {},
      fixture.controller.signal,
    ),
  );
  assert.deepEqual(fixture.installs, []);
});

test('an interrupted installation is returned to the caller without automatic retry', async () => {
  fixture.selectError = new AppletNotFoundError(new Uint8Array());
  fixture.installError = Object.assign(new Error('Card lost'), {
    code: 'TAG_LOST',
  });

  await assert.rejects(
    readCopyDestination(
      'destination',
      fixture.applet,
      () => {},
      fixture.controller.signal,
    ),
    error => error === fixture.installError,
  );
  assert.deepEqual(fixture.installs, ['destination']);
  assert.deepEqual(fixture.hellos, []);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return {promise, resolve, reject};
}

function cancel() {
  const error = Object.assign(new Error('Cancelled'), {code: 'CANCELLED'});
  fixture.controller.abort(error);
  return error;
}

test('an already cancelled destination scan never selects or installs an applet', async () => {
  const reason = cancel();

  await assert.rejects(
    readCopyDestination(
      'destination',
      fixture.applet,
      () => {},
      fixture.controller.signal,
    ),
    error => error === reason,
  );
  assert.deepEqual(fixture.sessions, []);
  assert.deepEqual(fixture.installs, []);
  assert.deepEqual(fixture.hellos, []);
});

test('a late missing-applet SELECT after cancellation cannot start installation', async () => {
  fixture.selectPending = deferred();
  const reading = readCopyDestination(
    'destination',
    fixture.applet,
    () => {},
    fixture.controller.signal,
  );
  const reason = cancel();
  fixture.selectPending.reject(new AppletNotFoundError(new Uint8Array()));

  await assert.rejects(reading, error => error === reason);
  assert.deepEqual(fixture.sessions, ['destination']);
  assert.deepEqual(fixture.installs, []);
  assert.deepEqual(fixture.hellos, []);
});

test('a late successful SELECT after cancellation cannot start reading hello', async () => {
  fixture.selectPending = deferred();
  const reading = readCopyDestination(
    'destination',
    fixture.applet,
    () => {},
    fixture.controller.signal,
  );
  const reason = cancel();
  fixture.selectPending.resolve();

  await assert.rejects(reading, error => error === reason);
  assert.deepEqual(fixture.installs, []);
  assert.deepEqual(fixture.hellos, []);
});

test('a hello returning after cancellation cannot report a destination', async () => {
  fixture.helloPending = deferred();
  const reading = readCopyDestination(
    'destination',
    fixture.applet,
    () => {},
    fixture.controller.signal,
  );
  await Promise.resolve();
  assert.deepEqual(fixture.hellos, [{safe: true}]);
  const reason = cancel();
  fixture.helloPending.resolve();

  await assert.rejects(reading, error => error === reason);
  assert.deepEqual(fixture.installs, []);
});
