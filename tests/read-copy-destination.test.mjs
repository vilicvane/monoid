import assert from 'node:assert/strict';
import {beforeEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {AppletISOError, AppletNotFoundError} from '../.bld/app/@lib/applet.js';

let fixture;

mock.module('../.bld/app/@lib/monoid/install.js', {
  namedExports: {
    installMonoidApplets: () => assert.fail('Copy must not install applets'),
  },
});

mock.module('../.bld/app/@lib/global-platform/card-information.js', {
  namedExports: {
    readCardInformation: async (sessionId, signal) => {
      fixture.informationReads.push(sessionId);
      assert.equal(signal, fixture.controller.signal);
      if (fixture.informationPending) await fixture.informationPending.promise;
      if (fixture.informationError) throw fixture.informationError;
      return fixture.cardInformation;
    },
  },
});

const {readCardForSetup} = await import(
  '../.bld/app/@components/views/safe/@card/read-card-for-setup.js'
);

beforeEach(() => {
  fixture = {
    controller: new AbortController(),
    sessions: [],
    informationReads: [],
    hellos: [],
    cardInformation: {
      cardManagerAid: 'a000000151000000',
      secureChannels: ['SCP03'],
      javaCardVersion: '3.0.5',
    },
    hello: {
      version: 1,
      id: Uint8Array.of(1, 2, 3, 4),
      publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(7)),
      bundle: false,
      authority: false,
      pins: {access: false, secret: false},
    },
    applet: {
      attachSession(sessionId) {
        fixture.sessions.push(sessionId);
        return {
          async select() {
            if (fixture.selectPending) await fixture.selectPending.promise;
            if (fixture.selectError) throw fixture.selectError;
          },
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

test('an installed destination reads its identity and PIN metadata without reading GP information', async () => {
  const result = await readCardForSetup(
    'destination',
    fixture.applet,
    () => assert.fail('Unexpected setup status'),
    fixture.controller.signal,
  );

  assert.deepEqual(result, {type: 'ready', hello: fixture.hello});
  assert.deepEqual(fixture.sessions, ['destination']);
  assert.deepEqual(fixture.hellos, [{}]);
  assert.deepEqual(fixture.informationReads, []);
});

test('a missing Monoid applet reads GP information in the same NFC session for Setup', async () => {
  fixture.selectError = new AppletNotFoundError(new Uint8Array());
  const statuses = [];
  const result = await readCardForSetup(
    'destination',
    fixture.applet,
    status => {
      assert.deepEqual(fixture.informationReads, []);
      statuses.push(status);
    },
    fixture.controller.signal,
  );

  assert.deepEqual(result, {
    type: 'setup',
    cardInformation: fixture.cardInformation,
  });
  assert.deepEqual(fixture.sessions, ['destination']);
  assert.deepEqual(fixture.informationReads, ['destination']);
  assert.deepEqual(fixture.hellos, []);
  assert.deepEqual(statuses, ['Reading card information, hold tight...']);
});

for (const error of [
  new AppletISOError('Selection failed', 0x6999, new Uint8Array()),
  Object.assign(new Error('Card lost'), {code: 'TAG_LOST'}),
]) {
  test(`a SELECT ${error.code ?? error.sw.toString(16)} failure does not read GP information`, async () => {
    fixture.selectError = error;

    await assert.rejects(
      readCardForSetup(
        'destination',
        fixture.applet,
        () => {},
        fixture.controller.signal,
      ),
      value => value === error,
    );
    assert.deepEqual(fixture.informationReads, []);
    assert.deepEqual(fixture.hellos, []);
  });
}

test('a hello error never triggers setup, even if it reports a missing applet', async () => {
  fixture.helloError = new AppletNotFoundError(new Uint8Array());

  await assert.rejects(
    readCardForSetup(
      'destination',
      fixture.applet,
      () => {},
      fixture.controller.signal,
    ),
    error => error === fixture.helloError,
  );
  assert.deepEqual(fixture.informationReads, []);
});

test('invalid identity metadata is rejected without trying to read GP information', async () => {
  delete fixture.hello.publicKey;

  await assert.rejects(
    readCardForSetup(
      'destination',
      fixture.applet,
      () => {},
      fixture.controller.signal,
    ),
  );
  assert.deepEqual(fixture.informationReads, []);
});

test('a GP read error is returned to the caller without retry or installation', async () => {
  fixture.selectError = new AppletNotFoundError(new Uint8Array());
  fixture.informationError = Object.assign(new Error('Card lost'), {
    code: 'TAG_LOST',
  });

  await assert.rejects(
    readCardForSetup(
      'destination',
      fixture.applet,
      () => {},
      fixture.controller.signal,
    ),
    error => error === fixture.informationError,
  );
  assert.deepEqual(fixture.informationReads, ['destination']);
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

test('an already cancelled destination scan never selects an applet or reads GP information', async () => {
  const reason = cancel();

  await assert.rejects(
    readCardForSetup(
      'destination',
      fixture.applet,
      () => {},
      fixture.controller.signal,
    ),
    error => error === reason,
  );
  assert.deepEqual(fixture.sessions, []);
  assert.deepEqual(fixture.informationReads, []);
  assert.deepEqual(fixture.hellos, []);
});

test('a late missing-applet SELECT after cancellation cannot start reading GP information', async () => {
  fixture.selectPending = deferred();
  const reading = readCardForSetup(
    'destination',
    fixture.applet,
    () => {},
    fixture.controller.signal,
  );
  const reason = cancel();
  fixture.selectPending.reject(new AppletNotFoundError(new Uint8Array()));

  await assert.rejects(reading, error => error === reason);
  assert.deepEqual(fixture.sessions, ['destination']);
  assert.deepEqual(fixture.informationReads, []);
  assert.deepEqual(fixture.hellos, []);
});

test('a late successful SELECT after cancellation cannot start reading hello', async () => {
  fixture.selectPending = deferred();
  const reading = readCardForSetup(
    'destination',
    fixture.applet,
    () => {},
    fixture.controller.signal,
  );
  const reason = cancel();
  fixture.selectPending.resolve();

  await assert.rejects(reading, error => error === reason);
  assert.deepEqual(fixture.informationReads, []);
  assert.deepEqual(fixture.hellos, []);
});

test('a hello returning after cancellation cannot report a destination', async () => {
  fixture.helloPending = deferred();
  const reading = readCardForSetup(
    'destination',
    fixture.applet,
    () => {},
    fixture.controller.signal,
  );
  await setImmediate();
  assert.deepEqual(fixture.hellos, [{}]);
  const reason = cancel();
  fixture.helloPending.resolve();

  await assert.rejects(reading, error => error === reason);
  assert.deepEqual(fixture.informationReads, []);
});

test('cancellation during the setup status update prevents reading GP information', async () => {
  fixture.selectError = new AppletNotFoundError(new Uint8Array());
  let reason;

  await assert.rejects(
    readCardForSetup(
      'destination',
      fixture.applet,
      () => {
        reason = cancel();
      },
      fixture.controller.signal,
    ),
    error => error === reason,
  );
  assert.deepEqual(fixture.informationReads, []);
  assert.deepEqual(fixture.hellos, []);
});

test('GP information returning after cancellation cannot request setup', async () => {
  fixture.selectError = new AppletNotFoundError(new Uint8Array());
  fixture.informationPending = deferred();
  const reading = readCardForSetup(
    'destination',
    fixture.applet,
    () => {},
    fixture.controller.signal,
  );
  await setImmediate();
  assert.deepEqual(fixture.informationReads, ['destination']);
  const reason = cancel();
  fixture.informationPending.resolve();

  await assert.rejects(reading, error => error === reason);
  assert.deepEqual(fixture.hellos, []);
});

test('a late GP read failure cannot request setup or retry the read', async () => {
  fixture.selectError = new AppletNotFoundError(new Uint8Array());
  fixture.informationPending = deferred();
  const reading = readCardForSetup(
    'destination',
    fixture.applet,
    () => {},
    fixture.controller.signal,
  );
  await setImmediate();
  cancel();
  const error = Object.assign(new Error('Card lost'), {code: 'TAG_LOST'});
  fixture.informationPending.reject(error);

  await assert.rejects(reading, value => value === error);
  assert.deepEqual(fixture.informationReads, ['destination']);
  assert.deepEqual(fixture.hellos, []);
});
