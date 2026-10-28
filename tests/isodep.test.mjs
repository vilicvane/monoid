import assert from 'node:assert/strict';
import {afterEach, beforeEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

let device;
let platform = 'android';

mock.module('@capacitor/core', {
  namedExports: {Capacitor: {getPlatform: () => platform}},
});

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
  platform = 'android';
  const listeners = new Map();

  device = {
    isActive: true,
    enabled: true,
    listeners,
    endedScans: new Set(),
    starts: [],
    stops: [],
    closes: [],
    closeOptions: [],
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
      await this.onStart?.();
    },
    async stopScan({scanId}) {
      this.stops.push(scanId);

      if (!this.endedScans.has(scanId)) {
        this.emit('scanEnded', {scanId, reason: 'stopped'});
      }

      await this.onStop?.(scanId);
    },
    async closeSession(options) {
      const {sessionId} = options;
      this.closes.push(sessionId);
      this.closeOptions.push(options);
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
    standby(callback, applet, getCloseOptions) {
      const args = [
        callback,
        error => this.errors.push(error),
        () => this.cleanupCount++,
        connected => this.connections.push(connected),
        getCloseOptions,
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
  assert.deepEqual(device.closeOptions, [
    {sessionId: 'first', waitForRemoval: false},
    {sessionId: 'second', waitForRemoval: false},
  ]);
  assert.equal(device.starts.length, 1);
  assert.equal(device.stops.length, 0);
  assert.deepEqual(device.errors, []);
  assert.deepEqual(device.connections, [true, false, true, false]);
});

for (const kind of ['raw', 'applet']) {
  test(`${kind} sends completion text with connection cleanup after the operation finishes`, async () => {
    platform = 'ios';
    const pending = deferred();
    let completed = false;
    let optionsRead = 0;
    device.standby(
      async () => {
        await pending.promise;
        completed = true;
      },
      kind === 'applet' ? new TestApplet(new Uint8Array([1])) : undefined,
      () => {
        optionsRead++;
        assert.equal(completed, true);
        return {message: ''};
      },
    );
    await until(() => device.starts.length === 1);
    device.tap('completed-session');
    await setImmediate();
    assert.equal(optionsRead, 0);
    assert.deepEqual(device.closeOptions, []);

    pending.resolve();
    await until(() => device.cleanupCount === 1);
    assert.equal(optionsRead, 1);
    assert.deepEqual(device.closeOptions, [
      {
        sessionId: 'completed-session',
        waitForRemoval: false,
        message: '',
      },
    ]);
    assert.deepEqual(device.errors, []);
  });
}

for (const ending of ['dispose', 'scan-ended']) {
  test(`${ending} discards completion options from an operation that resolves late`, async () => {
    platform = 'ios';
    const pending = deferred();
    let callbacks = 0;
    let optionsRead = 0;
    const dispose = device.standby(
      async () => {
        callbacks++;
        await pending.promise;
      },
      undefined,
      () => {
        optionsRead++;
        return {message: '', waitForRemoval: true};
      },
    );
    await until(() => device.starts.length === 1);
    device.tap('cancelled-session');
    await until(() => callbacks === 1);
    let stopped;
    if (ending === 'dispose') stopped = dispose();
    else device.emit('scanEnded', {scanId: device.scanId, reason: 'cancelled'});
    await until(() => device.stops.length === 1);

    pending.resolve();
    await stopped;
    await until(() => device.closes.length === 1);
    assert.equal(optionsRead, 0);
    assert.deepEqual(device.closeOptions, [
      {sessionId: 'cancelled-session', waitForRemoval: false},
    ]);
  });
}

for (const kind of ['raw', 'applet']) {
  test(`${kind} connection feedback exposes only the current native session ID`, async () => {
    const first = deferred();
    const second = deferred();
    const connections = [];
    const args = [
      async () => {
        await (connections.length === 1 ? first : second).promise;
      },
      error => device.errors.push(error),
      () => device.cleanupCount++,
      (connected, sessionId) => connections.push({connected, sessionId}),
    ];
    device.disposers.push(
      kind === 'raw'
        ? standbyIsoDep(...args)
        : new TestApplet(new Uint8Array([1])).standby(...args),
    );
    await until(() => device.starts.length === 1);
    device.tap('first-native-session');
    await setImmediate();
    assert.deepEqual(connections, [
      {connected: true, sessionId: 'first-native-session'},
    ]);
    first.resolve();
    await until(() => device.cleanupCount === 1);
    device.tap('second-native-session');
    await setImmediate();
    device.emit('sessionEnded', {
      scanId: device.scanId,
      sessionId: 'first-native-session',
      reason: 'closed',
    });
    assert.deepEqual(connections, [
      {connected: true, sessionId: 'first-native-session'},
      {connected: false, sessionId: undefined},
      {connected: true, sessionId: 'second-native-session'},
    ]);
    second.resolve();
    await until(() => device.cleanupCount === 2);
    assert.deepEqual(connections.at(-1), {
      connected: false,
      sessionId: undefined,
    });
    assert.deepEqual(device.errors, []);
  });
}

test('an operation error is reported before waiting for removal and cleanup resumes only after removal', async () => {
  const removed = deferred();
  const failure = new Error('The selected account is not on this card');
  let failed = false;
  device.onClose = sessionId =>
    sessionId === 'wrong-card' ? removed.promise : undefined;
  device.standby(
    async sessionId => {
      failed = sessionId === 'wrong-card';

      if (failed) throw failure;
    },
    undefined,
    () => {
      if (failed) assert.deepEqual(device.errors, [failure]);

      return {waitForRemoval: failed};
    },
  );
  await until(() => device.starts.length === 1);
  device.tap('wrong-card');
  await until(() => device.closes.length === 1);

  assert.deepEqual(device.errors, [failure]);
  assert.deepEqual(device.closeOptions, [
    {sessionId: 'wrong-card', waitForRemoval: true},
  ]);
  assert.deepEqual(device.connections, [true, false]);
  assert.equal(device.cleanupCount, 0);
  device.emit('sessionEnded', {
    scanId: device.scanId,
    sessionId: 'wrong-card',
    reason: 'closed',
  });
  await setImmediate();
  assert.equal(device.cleanupCount, 0);
  assert.deepEqual(device.errors, [failure]);

  removed.resolve();
  await until(() => device.cleanupCount === 1);
  device.tap('correct-card');
  await until(() => device.cleanupCount === 2);
  assert.deepEqual(device.closeOptions[1], {
    sessionId: 'correct-card',
    waitForRemoval: false,
  });
  assert.deepEqual(device.errors, [failure]);
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

test('SELECT 6a82 reports an absent applet before waiting for removal', async () => {
  const closed = deferred();
  let callbacks = 0;
  device.onExchange = () => ({data: [0x12, 0x34, 0x6a, 0x82]});
  device.onClose = () => closed.promise;
  device.standby(
    async () => callbacks++,
    new TestApplet(new Uint8Array([1])),
    () => ({waitForRemoval: true}),
  );
  await until(() => device.starts.length === 1);
  device.tap('missing-applet');
  await until(() => device.closes.length === 1);

  assert.equal(callbacks, 0);
  assert.equal(device.errors.length, 1);
  assert.deepEqual(device.closeOptions, [
    {sessionId: 'missing-applet', waitForRemoval: true},
  ]);
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
  await until(() => device.errors.length === 2);
  await assert.rejects(dispose(), error => error === failure);

  assert.equal(device.errors.length, 2);
  assert.ok(device.errors[0] instanceof AppletNotFoundError);
  assert.ok(device.errors[1] instanceof IsoDepScanError);
  assert.equal(device.errors[1].cause, failure);
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
  test(`a ${reason} without sessionOpened preserves its code before native cleanup`, async () => {
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

    assert.equal(device.errors.length, 1);
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

test('cancel reaches native stop while iOS reader activation is still pending', async () => {
  const activation = deferred();
  const stopped = deferred();
  device.onStart = () => activation.promise;
  device.onStop = () => {
    activation.reject(
      Object.assign(new Error('Cancelled'), {code: 'CANCELLED'}),
    );
    return stopped.promise;
  };
  const dispose = device.standby(async () =>
    assert.fail('Cancelled startup must not connect'),
  );
  await until(() => device.starts.length === 1);
  let completed = false;
  const closing = dispose().then(() => {
    completed = true;
  });
  await until(() => device.stops.length === 1);
  assert.equal(completed, false);
  stopped.resolve();
  await closing;
  assert.equal(completed, true);
  assert.deepEqual(device.errors, []);
});

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

test('cancel during removal waiting releases the scan and permits a fresh scan', async () => {
  const removed = deferred();
  const failure = new Error('Wrong card');
  device.onClose = () => removed.promise;
  device.onStop = async () => {
    removed.reject(Object.assign(new Error('Cancelled'), {code: 'CANCELLED'}));
  };
  const dispose = device.standby(
    async () => {
      throw failure;
    },
    undefined,
    () => ({waitForRemoval: true}),
  );
  await until(() => device.starts.length === 1);
  device.tap('waiting');
  await until(() => device.closes.length === 1);
  const completion = dispose();
  device.standby(async () => {});
  await completion;
  await until(() => device.starts.length === 2);

  assert.deepEqual(device.closeOptions, [
    {sessionId: 'waiting', waitForRemoval: true},
  ]);
  assert.deepEqual(device.errors, [failure]);
  assert.equal(device.cleanupCount, 0);
  assert.equal(device.listenerRemovals.length, 5);
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

  test(`${reason} cancels the pending operation before cleanup instead of continuing as though the card was removed`, async () => {
    const removed = deferred();
    let result;
    const completed = [];
    device.onClose = () => removed.promise;
    const dispose = standbyIsoDep(
      async () => {
        result = 'input';
      },
      error => {
        device.errors.push(error);
        result = 'cancelled';
      },
      () => {
        completed.push(result);
        void dispose();
      },
      undefined,
      () => ({waitForRemoval: true}),
    );
    device.disposers.push(dispose);
    await until(() => device.starts.length === 1);
    device.tap('waiting');
    await until(() => device.closes.length === 1);
    device[state] = false;
    device.emit(event, {});
    device.emit('scanEnded', {scanId: device.scanId, reason});
    removed.reject(
      Object.assign(new Error('Scan interrupted'), {
        code: reason === 'app-paused' ? 'APP_INACTIVE' : 'NFC_DISABLED',
      }),
    );
    await until(() => device.stops.length === 1);
    await until(() => device.listenerRemovals.length === 5);

    assert.equal(device.errors.length, 1);
    assert.equal(device.errors[0].constructor, Error);
    assert.equal(device.errors[0].code, 'CANCELLED');
    assert.equal(
      device.errors[0].cause.code,
      reason === 'app-paused' ? 'APP_INACTIVE' : 'NFC_DISABLED',
    );
    assert.deepEqual(completed, ['cancelled']);
    assert.equal(device.starts.length, 1);
    device[state] = true;
    device.emit(event, {});
    await setImmediate();
    assert.equal(device.starts.length, 1);
    device.standby(async () => {});
    await until(() => device.starts.length === 2);
    assert.equal(device.errors.length, 1);
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

for (const [reason, code] of [
  ['cancelled', 'CANCELLED'],
  ['timeout', 'TIMEOUT'],
]) {
  test(`iOS ${reason} before any card connection quietly cancels without retry`, async () => {
    platform = 'ios';
    device.standby(async () => assert.fail('No card was connected'));
    await until(() => device.starts.length === 1);
    device.emit('scanEnded', {scanId: device.scanId, reason});
    await until(() => device.errors.length === 1);
    await until(() => device.listenerRemovals.length === 5);

    assert.ok(device.errors[0] instanceof IsoDepScanError);
    assert.equal(device.errors[0].code, 'CANCELLED');
    assert.equal(device.starts.length, 1);
    assert.equal(device.cleanupCount, 1);
  });

  test(`iOS ${reason} during a card operation reports the scan failure before cleanup`, async () => {
    platform = 'ios';
    const operation = deferred();
    device.standby(() => operation.promise);
    await until(() => device.starts.length === 1);
    device.tap('active');
    device.emit('scanEnded', {scanId: device.scanId, reason});
    operation.resolve();
    await until(() => device.errors.length === 1);
    await until(() => device.listenerRemovals.length === 5);
    assert.equal(device.errors[0].code, code);
    assert.equal(device.cleanupCount, 1);
    assert.equal(device.starts.length, 1);
  });
}

test('an idle iOS timeout waits for native cleanup and does not restart scanning', async () => {
  platform = 'ios';
  const stopped = deferred();
  device.onStop = () => stopped.promise;
  const dispose = device.standby(async () =>
    assert.fail('No card was connected'),
  );
  await until(() => device.starts.length === 1);
  device.emit('scanEnded', {scanId: device.scanId, reason: 'timeout'});
  await until(() => device.stops.length === 1);

  assert.equal(device.errors.length, 0);
  assert.equal(device.cleanupCount, 0);
  assert.equal(device.listenerRemovals.length, 0);
  assert.equal(device.starts.length, 1);
  stopped.resolve();
  await until(() => device.listenerRemovals.length === 5);
  await dispose();
  assert.equal(device.errors.length, 1);
  assert.equal(device.errors[0].code, 'CANCELLED');
  assert.equal(device.cleanupCount, 1);
  assert.equal(device.starts.length, 1);
  assert.deepEqual(device.closes, []);
});

test('an Android timeout without a card retains TIMEOUT', async () => {
  device.standby(async () => assert.fail('No card was connected'));
  await until(() => device.starts.length === 1);
  device.emit('scanEnded', {scanId: device.scanId, reason: 'timeout'});
  await until(() => device.errors.length === 1);
  assert.equal(device.errors[0].code, 'TIMEOUT');
  assert.equal(device.starts.length, 1);
});

test('an iOS timeout after a completed card session retains TIMEOUT', async () => {
  platform = 'ios';
  device.standby(async () => {});
  await until(() => device.starts.length === 1);
  device.tap('completed');
  await until(() => device.cleanupCount === 1);
  device.emit('scanEnded', {scanId: device.scanId, reason: 'timeout'});
  await until(() => device.errors.length === 1);
  assert.equal(device.errors[0].code, 'TIMEOUT');
  assert.equal(device.starts.length, 1);
});

test('an iOS connect timeout before sessionOpened retains TIMEOUT', async () => {
  platform = 'ios';
  const closed = deferred();
  device.onClose = () => closed.promise;
  device.standby(async () => assert.fail('The connection did not succeed'));
  await until(() => device.starts.length === 1);
  device.emit('sessionEnded', {
    scanId: device.scanId,
    sessionId: 'unconnected',
    reason: 'connect-timeout',
    code: 'TIMEOUT',
  });
  device.emit('scanEnded', {scanId: device.scanId, reason: 'timeout'});
  await until(() => device.closes.length === 1 && device.stops.length === 1);
  assert.equal(device.errors.length, 0);
  closed.resolve();
  await until(() => device.errors.length === 1);
  assert.equal(device.errors[0].code, 'TIMEOUT');
  assert.equal(device.cleanupCount, 1);
  assert.equal(device.starts.length, 1);
});

test('an iOS timeout after a failed connection is not treated as idle', async () => {
  platform = 'ios';
  device.standby(async () => assert.fail('The connection did not succeed'));
  await until(() => device.starts.length === 1);
  device.emit('sessionEnded', {
    scanId: device.scanId,
    sessionId: 'unconnected',
    reason: 'io-error',
    code: 'IO_ERROR',
  });
  await until(() => device.cleanupCount === 1);
  assert.equal(device.errors[0].code, 'IO_ERROR');
  device.emit('scanEnded', {scanId: device.scanId, reason: 'timeout'});
  await until(() => device.errors.length === 2);
  assert.equal(device.errors[1].code, 'TIMEOUT');
  assert.equal(device.starts.length, 1);
});

for (const [failureCode, emitsTimeout, expectedCode] of [
  ['TIMEOUT', true, 'CANCELLED'],
  ['TIMEOUT', false, 'TIMEOUT'],
  ['IO_ERROR', true, 'IO_ERROR'],
]) {
  test(`iOS startup ${failureCode} with${emitsTimeout ? '' : 'out'} a reader timeout preserves ${expectedCode}`, async () => {
    platform = 'ios';
    device.onStart = async () => {
      if (emitsTimeout) {
        device.emit('scanEnded', {scanId: device.scanId, reason: 'timeout'});
      }
      throw Object.assign(new Error('Reader activation failed'), {
        code: failureCode,
      });
    };
    device.standby(async () => assert.fail('No card was connected'));
    await until(() => device.errors.length === 1);
    assert.equal(device.errors[0].code, expectedCode);
    assert.equal(device.stops.length, 1);
    assert.equal(device.starts.length, 1);
    assert.equal(device.cleanupCount, 1);
  });
}

for (const failedCleanup of ['stopScan', 'listener']) {
  test(`an idle iOS timeout does not suppress ${failedCleanup} cleanup failure`, async () => {
    platform = 'ios';
    const failure = Object.assign(new Error('Native cleanup failed'), {
      code: 'TIMEOUT',
    });
    if (failedCleanup === 'stopScan') {
      device.onStop = async () => {
        throw failure;
      };
    } else {
      device.onRemove = async name => {
        if (name === 'sessionOpened') throw failure;
      };
    }
    const dispose = device.standby(async () =>
      assert.fail('No card was connected'),
    );
    await until(() => device.starts.length === 1);
    device.emit('scanEnded', {scanId: device.scanId, reason: 'timeout'});
    await until(() => device.listenerRemovals.length === 5);
    await assert.rejects(dispose(), error => error === failure);
    if (failedCleanup === 'stopScan') {
      assert.equal(device.errors.length, 1);
      assert.equal(device.errors[0].cause, failure);
    }
    assert.equal(device.starts.length, 1);
  });
}

test('iOS backgrounding terminates a pending operation instead of replaying it on foreground', async () => {
  platform = 'ios';
  const operation = deferred();
  let callbacks = 0;
  device.standby(() => {
    callbacks++;
    return operation.promise;
  });
  await until(() => device.starts.length === 1);
  device.tap('active');
  device.isActive = false;
  device.emit('scanEnded', {scanId: device.scanId, reason: 'app-paused'});
  operation.reject(
    Object.assign(new Error('The old session closed'), {
      code: 'SESSION_CLOSED',
    }),
  );
  await until(() => device.errors.length === 1);
  await until(() => device.listenerRemovals.length === 5);
  device.isActive = true;
  device.emit('appStateChange', {isActive: true});
  await setImmediate();
  assert.equal(device.errors[0].code, 'APP_INACTIVE');
  assert.equal(device.cleanupCount, 1);
  assert.equal(callbacks, 1);
  assert.equal(device.starts.length, 1);
});

for (const currentPlatform of ['android', 'ios']) {
  test(`${currentPlatform} BUSY startup reports a scan error after cleanup without retrying`, async () => {
    platform = currentPlatform;
    const failure = Object.assign(
      new Error('Scanning is already active or stopping.'),
      {code: 'BUSY'},
    );
    const stopped = deferred();
    device.onStart = async () => {
      throw failure;
    };
    device.onStop = () => stopped.promise;
    let callbacks = 0;
    const dispose = device.standby(async () => callbacks++);
    await until(() => device.stops.length === 1);
    assert.deepEqual(device.errors, []);
    assert.equal(device.cleanupCount, 0);

    stopped.resolve();
    await until(() => device.errors.length === 1);
    await dispose();
    assert.ok(device.errors[0] instanceof IsoDepScanError);
    assert.equal(device.errors[0].code, 'BUSY');
    assert.equal(device.errors[0].cause, failure);
    assert.equal(device.cleanupCount, 1);
    assert.equal(device.starts.length, 1);
    assert.equal(device.stops.length, 1);
    assert.equal(callbacks, 0);
    assert.ok(
      [...device.listeners.values()].every(entries => entries.size === 0),
    );
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
