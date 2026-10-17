import assert from 'node:assert/strict';
import {afterEach, beforeEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

let device;

mock.module('@capacitor/app', {
  namedExports: {
    App: {
      addListener: (...args) => device.addListener(...args),
      getState: async () => ({isActive: device.isActive}),
    },
  },
});

mock.module('capacitor-isodep-nfc', {
  namedExports: {
    IsoDepNfc: Object.fromEntries(
      [
        'addListener',
        'getStatus',
        'startScan',
        'stopScan',
        'closeSession',
        'transceive',
      ].map(method => [method, (...args) => device[method](...args)]),
    ),
  },
});

const {standbyIsoDep, IsoDepScanError} = await import(
  '../.bld/app/@lib/isodep.js'
);
const {Applet, AppletISOError, AppletNotFoundError} = await import(
  '../.bld/app/@lib/applet.js'
);

async function until(condition) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) {
      return;
    }

    await setImmediate();
  }

  assert.fail('Expected asynchronous state was not reached.');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  device.release.push(resolve);

  return {promise, resolve, reject};
}

class TestApplet extends Applet {
  encode(data) {
    return data;
  }

  decode(data) {
    return data;
  }
}

beforeEach(() => {
  const listeners = new Map();

  device = {
    isActive: true,
    enabled: true,
    listeners,
    endedScans: new Set(),
    starts: [],
    stops: [],
    closes: [],
    listenerRemovals: [],
    exchanges: [],
    connections: [],
    errors: [],
    cleanupCount: 0,
    disposers: [],
    release: [],
    emit(name, event) {
      if (name === 'scanEnded') {
        this.endedScans.add(event.scanId);
      }

      for (const listener of listeners.get(name) ?? []) {
        listener(event);
      }
    },
    async addListener(name, listener) {
      const entries = listeners.get(name) ?? new Set();
      listeners.set(name, entries);
      entries.add(listener);

      return {
        remove: async () => {
          this.listenerRemovals.push(name);
          await this.onRemove?.(name);
          entries.delete(listener);
        },
      };
    },
    async getStatus() {
      return {supported: true, enabled: this.enabled};
    },
    async startScan({scanId}) {
      for (const name of ['sessionOpened', 'sessionEnded', 'scanEnded']) {
        assert.ok(
          listeners.get(name)?.size,
          `${name} must be registered before scanning`,
        );
      }

      this.scanId = scanId;
      this.starts.push(scanId);
    },
    async stopScan({scanId}) {
      this.stops.push(scanId);

      if (!this.endedScans.has(scanId)) {
        this.emit('scanEnded', {scanId, reason: 'stopped'});
      }

      await this.onStop?.(scanId);
    },
    async closeSession({sessionId}) {
      this.closes.push(sessionId);
      this.emit('sessionEnded', {
        scanId: this.scanId,
        sessionId,
        reason: 'closed',
      });
      await this.onClose?.(sessionId);
    },
    async transceive(options) {
      this.exchanges.push(options);

      return (await this.onExchange?.(options)) ?? {data: [0x90, 0x00]};
    },
    tap(sessionId) {
      this.emit('sessionOpened', {scanId: this.scanId, sessionId, tag: {}});
    },
    standby(callback, applet) {
      const args = [
        callback,
        error => this.errors.push(error),
        () => this.cleanupCount++,
        connected => this.connections.push(connected),
      ];
      const dispose = applet ? applet.standby(...args) : standbyIsoDep(...args);
      this.disposers.push(dispose);

      return dispose;
    },
  };
});

afterEach(async () => {
  const completions = device.disposers.map(dispose => dispose());
  device.release.forEach(resolve => resolve());
  await Promise.allSettled(completions);
  await setImmediate();
});

test('successive card taps close only their sessions and leave scanning active', async () => {
  const seen = [];
  device.standby(async sessionId => seen.push(sessionId));
  await until(() => device.starts.length === 1);

  device.tap('first');
  await until(() => device.cleanupCount === 1);
  device.tap('second');
  await until(() => device.cleanupCount === 2);

  assert.deepEqual(seen, ['first', 'second']);
  assert.deepEqual(device.closes, ['first', 'second']);
  assert.equal(device.starts.length, 1);
  assert.equal(device.stops.length, 0);
  assert.deepEqual(device.errors, []);
  assert.deepEqual(device.connections, [true, false, true, false]);
});

test('connection notification precedes SELECT and remains active while SELECT is pending', async () => {
  const selected = deferred();
  let callbacks = 0;
  device.onExchange = () => {
    assert.deepEqual(device.connections, [true]);
    return selected.promise;
  };
  device.standby(async () => callbacks++, new TestApplet(new Uint8Array([1])));
  await until(() => device.starts.length === 1);
  device.tap('selecting');
  await until(() => device.exchanges.length === 1);

  assert.deepEqual(device.connections, [true]);
  assert.equal(callbacks, 0);
  selected.resolve({data: [0x90, 0x00]});
  await until(() => device.cleanupCount === 1);
  assert.equal(callbacks, 1);
  assert.deepEqual(device.connections, [true, false]);
});

test('sessionEnded disconnects before the operation and native close finish without duplicate notifications', async () => {
  const operation = deferred();
  const closed = deferred();
  device.onClose = () => closed.promise;
  device.standby(() => operation.promise);
  await until(() => device.starts.length === 1);
  device.tap('removed');
  assert.deepEqual(device.connections, [true]);

  const ended = {
    scanId: device.scanId,
    sessionId: 'removed',
    reason: 'tag-lost',
    code: 'TAG_LOST',
  };
  device.emit('sessionEnded', ended);
  device.emit('sessionEnded', ended);
  assert.deepEqual(device.connections, [true, false]);
  assert.equal(device.closes.length, 0);
  assert.equal(device.cleanupCount, 0);

  operation.resolve();
  await until(() => device.closes.length === 1);
  assert.equal(device.cleanupCount, 0);
  assert.deepEqual(device.connections, [true, false]);
  closed.resolve();
  await until(() => device.cleanupCount === 1);
  assert.deepEqual(device.connections, [true, false]);
  assert.deepEqual(device.errors, []);
});

test('late events and cleanup from an older session cannot disconnect the current connection', async () => {
  const first = deferred();
  const second = deferred();
  const seen = [];
  device.standby(sessionId => {
    seen.push(sessionId);
    return sessionId === 'first' ? first.promise : second.promise;
  });
  await until(() => device.starts.length === 1);
  device.tap('first');
  const endedFirst = {
    scanId: device.scanId,
    sessionId: 'first',
    reason: 'tag-lost',
    code: 'TAG_LOST',
  };
  device.emit('sessionEnded', endedFirst);
  device.tap('second');
  device.tap('second');
  device.tap('first');
  device.emit('sessionEnded', endedFirst);
  device.emit('sessionOpened', {
    scanId: 'old-scan',
    sessionId: 'old-session',
    tag: {},
  });
  device.emit('sessionEnded', {...endedFirst, scanId: 'old-scan'});
  device.emit('scanEnded', {scanId: 'old-scan', reason: 'stopped'});
  first.resolve();
  await until(() => device.cleanupCount === 1);

  assert.deepEqual(seen, ['first', 'second']);
  assert.deepEqual(device.connections, [true, false, true]);
  assert.deepEqual(device.errors, []);
  second.resolve();
  await until(() => device.cleanupCount === 2);
  assert.deepEqual(device.connections, [true, false, true, false]);
});

test('scanEnded disconnects immediately and ignores late opening events while cleanup waits', async () => {
  const operation = deferred();
  const closed = deferred();
  let callbacks = 0;
  device.onClose = () => closed.promise;
  device.standby(() => {
    callbacks++;
    return operation.promise;
  });
  await until(() => device.starts.length === 1);
  device.tap('active');
  device.enabled = false;
  device.emit('scanEnded', {
    scanId: device.scanId,
    reason: 'nfc-disabled',
  });
  assert.deepEqual(device.connections, [true, false]);
  device.tap('late');
  assert.equal(callbacks, 1);
  operation.resolve();
  await until(() => device.closes.length === 1);
  assert.deepEqual(device.connections, [true, false]);
  closed.resolve();
});

test('SELECT and GET RESPONSE preserve APDU bytes and cannot switch to a newer session', async () => {
  const applet = new TestApplet(new Uint8Array([1, 2, 3]));
  const command = new Uint8Array([0x00, 0x01, 0x00, 0x00]);
  let firstApplet;

  device.onExchange = async ({sessionId, data}) => {
    if (device.closes.includes(sessionId)) {
      throw Object.assign(new Error('Session closed'), {
        code: 'SESSION_CLOSED',
      });
    }

    if (data[1] === 0x01) {
      return {data: [0x11, 0x61, 0x01]};
    }

    if (data[1] === 0xc0) {
      return {data: [0x22, 0x90, 0x00]};
    }
  };

  device.standby(async sessionApplet => {
    if (firstApplet) {
      await assert.rejects(firstApplet.sendRawCommand(command), {
        code: 'SESSION_CLOSED',
      });
    } else {
      firstApplet = sessionApplet;
    }

    assert.deepEqual(
      await sessionApplet.sendRawCommand(command),
      new Uint8Array([0x11, 0x22]),
    );
  }, applet);
  await until(() => device.starts.length === 1);
  device.tap('first');
  await until(() => device.cleanupCount === 1);
  device.tap('second');
  await until(() => device.cleanupCount === 2);

  assert.deepEqual(device.errors, []);
  assert.deepEqual(device.exchanges, [
    {sessionId: 'first', data: [0, 0xa4, 4, 0, 3, 1, 2, 3]},
    {sessionId: 'first', data: [...command]},
    {sessionId: 'first', data: [0, 0xc0, 0, 0, 1]},
    {sessionId: 'second', data: [0, 0xa4, 4, 0, 3, 1, 2, 3]},
    {sessionId: 'first', data: [...command]},
    {sessionId: 'second', data: [...command]},
    {sessionId: 'second', data: [0, 0xc0, 0, 0, 1]},
  ]);
  await assert.rejects(applet.sendRawCommand(command), /open NFC session/);
});

test('SELECT 6a82 reports an absent applet only after native session cleanup', async () => {
  const closed = deferred();
  let callbacks = 0;
  device.onExchange = () => ({data: [0x12, 0x34, 0x6a, 0x82]});
  device.onClose = () => closed.promise;
  device.standby(async () => callbacks++, new TestApplet(new Uint8Array([1])));
  await until(() => device.starts.length === 1);
  device.tap('missing-applet');
  await until(() => device.closes.length === 1);

  assert.equal(callbacks, 0);
  assert.equal(device.errors.length, 0);
  assert.equal(device.cleanupCount, 0);
  closed.resolve();
  await until(() => device.cleanupCount === 1);

  assert.equal(device.errors.length, 1);
  const [error] = device.errors;
  assert.ok(error instanceof AppletNotFoundError);
  assert.ok(error instanceof AppletISOError);
  assert.equal(error.sw, 0x6a82);
  assert.deepEqual(error.data, new Uint8Array([0x12, 0x34]));
  assert.deepEqual(device.connections, [true, false]);
});

test('SELECT 6999 remains an ordinary selection failure', async () => {
  let callbacks = 0;
  device.onExchange = () => ({data: [0x69, 0x99]});
  device.standby(async () => callbacks++, new TestApplet(new Uint8Array([1])));
  await until(() => device.starts.length === 1);
  device.tap('selection-refused');
  await until(() => device.cleanupCount === 1);

  assert.equal(callbacks, 0);
  assert.equal(device.errors.length, 1);
  assert.equal(device.errors[0].constructor, AppletISOError);
  assert.equal(device.errors[0].sw, 0x6999);
});

test('a business command returning 6a82 does not imply an absent applet', async () => {
  device.onExchange = ({data}) =>
    data[1] === 0xa4 ? {data: [0x90, 0x00]} : {data: [0x42, 0x6a, 0x82]};
  device.standby(
    async applet => {
      await applet.sendCommand(0x01, new Uint8Array([0xa0]));
    },
    new TestApplet(new Uint8Array([1])),
  );
  await until(() => device.starts.length === 1);
  device.tap('selected');
  await until(() => device.cleanupCount === 1);

  assert.equal(device.errors.length, 1);
  assert.equal(device.errors[0].constructor, AppletISOError);
  assert.equal(device.errors[0].sw, 0x6a82);
  assert.deepEqual(device.errors[0].data, new Uint8Array([0x42]));
});

for (const sw of [0x9000, 0x6a82]) {
  test(`SELECT GET RESPONSE ${sw.toString(16)} is handled outside applet absence detection`, async () => {
    let callbacks = 0;
    device.onExchange = ({data}) =>
      data[1] === 0xa4
        ? {data: [0x11, 0x61, 0x01]}
        : {data: [0x22, sw >> 8, sw & 0xff]};
    device.standby(
      async () => callbacks++,
      new TestApplet(new Uint8Array([1])),
    );
    await until(() => device.starts.length === 1);
    device.tap('select-response');
    await until(() => device.cleanupCount === 1);

    assert.deepEqual(device.exchanges, [
      {sessionId: 'select-response', data: [0, 0xa4, 4, 0, 1, 1]},
      {sessionId: 'select-response', data: [0, 0xc0, 0, 0, 1]},
    ]);

    if (sw === 0x9000) {
      assert.equal(callbacks, 1);
      assert.deepEqual(device.errors, []);
    } else {
      assert.equal(callbacks, 0);
      assert.equal(device.errors.length, 1);
      assert.equal(device.errors[0].constructor, AppletISOError);
      assert.equal(device.errors[0].sw, sw);
      assert.deepEqual(device.errors[0].data, new Uint8Array([0x22]));
    }
  });
}

test('a SELECT 6a82 cannot hide a subsequent session cleanup failure', async () => {
  const failure = new Error('Session cleanup failed');
  device.onExchange = () => ({data: [0x6a, 0x82]});
  device.onClose = async () => {
    throw failure;
  };
  const dispose = device.standby(
    async () => assert.fail('An absent applet must not reach the callback'),
    new TestApplet(new Uint8Array([1])),
  );
  await until(() => device.starts.length === 1);
  device.tap('failed-close');
  await until(() => device.errors.length === 1);
  await assert.rejects(dispose(), error => error === failure);

  assert.equal(device.errors.length, 1);
  assert.ok(device.errors[0] instanceof IsoDepScanError);
  assert.equal(device.errors[0].cause, failure);
  assert.equal(device.cleanupCount, 1);
});

test('a rejected exchange and its sessionEnded event report one error and permit another tap', async () => {
  const failure = Object.assign(new Error('Card removed'), {code: 'TAG_LOST'});
  device.onExchange = async ({sessionId}) => {
    if (sessionId === 'first') {
      await setImmediate();
      device.emit('sessionEnded', {
        scanId: device.scanId,
        sessionId,
        reason: 'tag-lost',
        code: 'TAG_LOST',
      });
      throw failure;
    }
  };
  const dispose = device.standby(
    async () => {},
    new TestApplet(new Uint8Array([1])),
  );
  await until(() => device.starts.length === 1);
  device.tap('first');
  await until(() => device.cleanupCount === 1);
  device.tap('second');
  await until(() => device.cleanupCount === 2);

  assert.deepEqual(device.errors, [failure]);
  assert.equal(device.starts.length, 1);
  await dispose();
});

for (const [reason, code] of [
  ['connect-timeout', 'TIMEOUT'],
  ['tag-lost', 'TAG_LOST'],
]) {
  test(`a ${reason} without sessionOpened preserves its code after native cleanup`, async () => {
    const closed = deferred();
    let callbacks = 0;
    device.onClose = () => closed.promise;
    device.standby(async () => callbacks++);
    await until(() => device.starts.length === 1);
    device.emit('sessionEnded', {
      scanId: device.scanId,
      sessionId: 'unconnected',
      reason,
      code,
    });
    await until(() => device.closes.length === 1);

    assert.equal(device.errors.length, 0);
    assert.equal(device.cleanupCount, 0);
    closed.resolve();
    await until(() => device.cleanupCount === 1);
    assert.equal(callbacks, 0);
    assert.equal(device.errors.length, 1);
    assert.ok(device.errors[0].message.includes(reason));
    assert.equal(device.errors[0].code, code);
    device.tap('connected');
    await until(() => callbacks === 1);
  });
}

test('cancel is immediate while completion and reopening wait for native stop, close, and listener cleanup', async () => {
  const stopped = deferred();
  const exchange = deferred();
  const closed = deferred();
  const removed = deferred();
  device.onExchange = () => exchange.promise;
  device.onClose = () => closed.promise;
  device.onRemove = () => removed.promise;
  device.onStop = async () => {
    exchange.reject(Object.assign(new Error('Cancelled'), {code: 'CANCELLED'}));
    await stopped.promise;
  };
  const dispose = device.standby(
    async () => {},
    new TestApplet(new Uint8Array([1])),
  );
  await until(() => device.starts.length === 1);
  device.tap('cancelled');
  await until(() => device.exchanges.length === 1);
  let completed = false;
  const completion = dispose();
  assert.deepEqual(device.connections, [true, false]);
  completion.then(() => {
    completed = true;
  });
  assert.equal(dispose(), completion);
  device.tap('late-after-cancel');
  assert.deepEqual(device.connections, [true, false]);
  device.standby(async () => {});
  await until(() => device.stops.length === 1 && device.closes.length === 1);
  await setImmediate();

  assert.equal(completed, false);
  assert.equal(device.starts.length, 1);
  stopped.resolve();
  await setImmediate();
  assert.equal(completed, false);
  assert.equal(device.starts.length, 1);
  assert.equal(device.listenerRemovals.length, 0);
  closed.resolve();
  await until(() => device.listenerRemovals.length === 5);
  assert.equal(completed, false);
  assert.equal(device.starts.length, 1);
  removed.resolve();
  await completion;
  await until(() => device.starts.length === 2);
  assert.equal(completed, true);
  assert.notEqual(device.starts[0], device.starts[1]);
  assert.deepEqual(device.errors, []);
  assert.equal(device.cleanupCount, 0);
});

test('a scan cancelled before its turn never starts and finishes after the previous scan', async () => {
  const disposeFirst = device.standby(async () => {});
  await until(() => device.starts.length === 1);
  const disposeQueued = device.standby(async () => {});
  let completed = false;
  const queuedCompletion = disposeQueued();
  queuedCompletion.then(() => {
    completed = true;
  });
  await setImmediate();

  assert.equal(completed, false);
  assert.equal(device.starts.length, 1);
  assert.equal(device.stops.length, 0);
  await disposeFirst();
  await queuedCompletion;
  assert.equal(completed, true);
  assert.equal(device.starts.length, 1);
  assert.equal(device.stops.length, 1);
  assert.equal(device.listenerRemovals.length, 5);

  device.standby(async () => {});
  await until(() => device.starts.length === 2);
  assert.deepEqual(device.errors, []);
});

test('an independent cleanup continuation can await stop without blocking session cleanup', async () => {
  let completed = false;
  let finalization;
  const dispose = standbyIsoDep(
    async () => {},
    error => device.errors.push(error),
    () => {
      finalization = (async () => {
        await dispose();
        completed = true;
      })();
    },
  );
  device.disposers.push(dispose);
  await until(() => device.starts.length === 1);
  device.tap('complete');
  await until(() => completed);
  await finalization;

  assert.deepEqual(device.closes, ['complete']);
  assert.equal(device.stops.length, 1);
  assert.equal(device.listenerRemovals.length, 5);
  assert.deepEqual(device.errors, []);
});

for (const failedCleanup of ['stopScan', 'closeSession', 'listener']) {
  test(`${failedCleanup} failure rejects stop after all cleanup settles and does not block the next scan`, async () => {
    const failure = new Error(`${failedCleanup} cleanup failed`);
    const exchange = deferred();
    const removed = deferred();
    device.onExchange = () => exchange.promise;
    device.onStop = async () => {
      exchange.reject(
        Object.assign(new Error('Cancelled'), {code: 'CANCELLED'}),
      );
      if (failedCleanup === 'stopScan') throw failure;
    };
    device.onClose = async () => {
      if (failedCleanup === 'closeSession') throw failure;
    };
    device.onRemove = async name => {
      if (failedCleanup === 'listener' && name === 'sessionOpened') {
        throw failure;
      }

      if (name === 'statusChanged') await removed.promise;
    };
    const dispose = device.standby(
      async () => {},
      new TestApplet(new Uint8Array([1])),
    );
    await until(() => device.starts.length === 1);
    device.tap('active');
    await until(() => device.exchanges.length === 1);
    let settled = false;
    const rejected = assert
      .rejects(dispose(), error => error === failure)
      .then(() => {
        settled = true;
      });
    device.standby(async () => {});
    await until(() => device.listenerRemovals.length === 5);

    assert.equal(settled, false);
    assert.deepEqual(device.closes, ['active']);
    assert.equal(device.stops.length, 1);
    assert.equal(device.starts.length, 1);
    assert.deepEqual(device.errors, []);
    device.onStop = undefined;
    device.onClose = undefined;
    device.onRemove = undefined;
    removed.resolve();
    await rejected;
    await until(() => device.starts.length === 2);
    assert.equal(settled, true);
    assert.deepEqual(device.errors, []);
  });
}

test('a close failure terminates the active scan and preserves its cleanup error for stop', async () => {
  const failure = new Error('Session cleanup failed');
  device.onClose = async () => {
    throw failure;
  };
  const dispose = device.standby(async () => {});
  await until(() => device.starts.length === 1);
  device.tap('failed-close');
  await until(() => device.errors.length === 1);
  await assert.rejects(dispose(), error => error === failure);

  assert.ok(device.errors[0] instanceof IsoDepScanError);
  assert.equal(device.errors[0].cause, failure);
  assert.equal(device.cleanupCount, 1);
  assert.equal(device.stops.length, 1);
  assert.equal(device.starts.length, 1);
  assert.equal(device.listenerRemovals.length, 5);
});

for (const [reason, state, event] of [
  ['app-paused', 'isActive', 'appStateChange'],
  ['nfc-disabled', 'enabled', 'statusChanged'],
]) {
  test(`${reason} waits for availability before starting a fresh scan`, async () => {
    device.standby(async () => {});
    await until(() => device.starts.length === 1);
    device[state] = false;
    device.emit(event, {});
    device.emit('scanEnded', {scanId: device.scanId, reason});
    await until(() => device.stops.length === 1);
    await setImmediate();
    assert.equal(device.starts.length, 1);

    device[state] = true;
    device.emit(event, {});
    await until(() => device.starts.length === 2);
    assert.notEqual(device.starts[0], device.starts[1]);
    assert.deepEqual(device.errors, []);
  });

  test(`${reason} reports failed session and scan cleanup as one fatal error`, async () => {
    const exchange = deferred();
    const closed = deferred();
    device.onExchange = () => exchange.promise;
    device.onClose = () => closed.promise;
    device.onStop = async () => {
      throw new Error('Scan cleanup failed');
    };
    device.standby(async () => {}, new TestApplet(new Uint8Array([1])));
    await until(() => device.starts.length === 1);
    device.tap('interrupted');
    await until(() => device.exchanges.length === 1);
    device[state] = false;
    device.emit(event, {});
    device.emit('sessionEnded', {
      scanId: device.scanId,
      sessionId: 'interrupted',
      reason,
      code: reason === 'app-paused' ? 'APP_INACTIVE' : 'NFC_DISABLED',
    });
    device.emit('scanEnded', {scanId: device.scanId, reason});
    exchange.reject(new Error('Connection interrupted'));
    await until(() => device.stops.length === 1 && device.closes.length === 1);
    await setImmediate();

    assert.equal(device.errors.length, 0);
    assert.equal(device.cleanupCount, 0);
    closed.reject(new Error('Session cleanup failed'));
    await until(() => device.errors.length === 1);
    await until(() =>
      [...device.listeners.values()].every(entries => entries.size === 0),
    );

    assert.ok(device.errors[0] instanceof IsoDepScanError);
    assert.equal(device.errors.length, 1);
    assert.equal(device.cleanupCount, 1);
    assert.equal(device.starts.length, 1);
  });
}

test('fatal scan termination reports one scan error and releases every listener', async () => {
  device.standby(async () => {});
  await until(() => device.starts.length === 1);
  device.emit('scanEnded', {
    scanId: device.scanId,
    reason: 'io-error',
    code: 'IO_ERROR',
  });
  await until(() => device.errors.length === 1);
  await until(() =>
    [...device.listeners.values()].every(entries => entries.size === 0),
  );

  assert.ok(device.errors[0] instanceof IsoDepScanError);
  assert.match(device.errors[0].message, /io-error/);
  assert.equal(device.cleanupCount, 1);
  assert.equal(device.starts.length, 1);
  assert.equal(device.stops.length, 1);
});
