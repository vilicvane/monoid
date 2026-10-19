import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {MonoidCardError} from '../.bld/app/@lib/monoid/card-error.js';

let fixture;
let rendering;
let platform = 'android';
const owners = [];

mock.module('@capacitor/core', {
  namedExports: {Capacitor: {getPlatform: () => platform}},
});

mock.module('react/jsx-runtime', {
  namedExports: {
    jsx: (type, props) => ({type, props}),
    jsxs: (type, props) => ({type, props}),
    Fragment: 'fragment',
  },
});

mock.module('react', {
  namedExports: {
    useRef(initial) {
      const index = rendering.index++;
      return (rendering.slots[index] ??= {current: initial});
    },
    useCallback: callback => callback,
    useLayoutEffect(effect) {
      rendering.cleanups.push(effect());
    },
  },
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => fixture.entrances},
});
mock.module('../.bld/app/@lib/isodep.js', {
  namedExports: {
    IsoDepScanError: class extends Error {},
    standbyIsoDep(
      callback,
      onError,
      onCleanup,
      onConnectionChange,
      getCloseOptions,
    ) {
      const scan = {
        callback,
        onError,
        onCleanup,
        onConnectionChange,
        getCloseOptions,
        stopped: deferred(),
        stopCalls: 0,
      };
      fixture.scans.push(scan);
      return () => {
        scan.stopCalls++;
        return scan.stopped.promise;
      };
    },
  },
});
mock.module('../.bld/app/@services/index.js', {
  namedExports: {
    isCredentialRequestCancelled: error => error?.code === 'CANCELLED',
  },
});

mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {MonoidCardError},
});

const {MonoidScanPromptPresenter} = await import(
  '../.bld/app/@services/monoid-scan-prompt-presenter.js'
);
const {useIsoDepScanPrompt} = await import(
  '../.bld/app/@components/@monoid/use-isodep-scan-prompt.js'
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return {promise, resolve, reject};
}

function setup() {
  const presenter = new MonoidScanPromptPresenter();
  const presentedErrors = [];
  const owner = {
    slots: [],
    index: 0,
    cleanups: [],
    unmount() {
      this.cleanups.splice(0).forEach(cleanup => cleanup?.());
    },
  };
  owners.push(owner);
  fixture = {
    entrances: {
      monoidScanPromptPresenter: presenter,
      errorService: {markPresented: error => presentedErrors.push(error)},
    },
    scans: [],
  };
  rendering = owner;
  const prompt = useIsoDepScanPrompt();
  rendering = undefined;

  const start = callback => {
    let settled = false;
    const promise = prompt('Hold card', callback).then(
      () => ({success: true}),
      error => ({error}),
    );
    void promise.then(() => {
      settled = true;
    });
    return {
      promise,
      scan: fixture.scans.at(-1),
      get settled() {
        return settled;
      },
    };
  };

  return {presenter, owner, start, scans: fixture.scans, presentedErrors};
}

async function connect(scan) {
  scan.onConnectionChange(true);
  try {
    await scan.callback('native-session');
  } catch (error) {
    scan.onError(error);
  }
  scan.closeOptions = scan.getCloseOptions();
  scan.waitingForRemoval = scan.closeOptions.waitForRemoval ?? false;
  scan.onConnectionChange(false);
  scan.onCleanup();
  await setImmediate();
}

function hide(presenter, completed = true) {
  presenter.remove(presenter.current, completed);
}

afterEach(() => {
  owners.splice(0).forEach(owner => owner.unmount());
  platform = 'android';
});

test('iOS closes the native sheet before returning an operation error', async () => {
  platform = 'ios';
  const {presenter, start} = setup();
  const failure = new Error('Could not install applet');
  const run = start(async () => {
    throw failure;
  });
  await connect(run.scan);
  assert.equal(run.scan.waitingForRemoval, false);
  assert.deepEqual(run.scan.closeOptions, {
    errorMessage: 'Card operation failed.',
  });
  assert.notEqual(presenter.current.content, '');
  assert.equal(run.scan.stopCalls, 1);
  assert.equal(run.settled, false);
  hide(presenter);
  assert.equal(run.settled, false);
  run.scan.stopped.resolve();
  assert.equal((await run.promise).error, failure);
});

test('raw scan presentation binds progress to its native session and clears it after callback completion', async () => {
  platform = 'ios';
  const {presenter, start} = setup();
  const run = start(async (_sessionId, setContent) => {
    setContent('Installing applet\n42%');
  });
  assert.equal(presenter.current.sessionId, undefined);
  run.scan.onConnectionChange(true, 'install-session');
  assert.equal(presenter.current.sessionId, 'install-session');
  await run.scan.callback('install-session');
  assert.equal(presenter.current.content, '');
  assert.deepEqual(run.scan.getCloseOptions(), {message: ''});
  assert.equal(presenter.current.sessionId, 'install-session');
  run.scan.onConnectionChange(false);
  assert.equal(presenter.current.sessionId, undefined);
  run.scan.onConnectionChange(true, 'late-session');
  assert.equal(presenter.current.sessionId, undefined);
  run.scan.onCleanup();
  await setImmediate();
  run.scan.stopped.resolve();
  hide(presenter);
  assert.deepEqual(await run.promise, {success: true});
});

test('failure is displayed while waiting for removal and can be cancelled', async () => {
  const {presenter, start} = setup();
  const failure = new Error('Could not install applet');
  const run = start(async () => {
    throw failure;
  });
  run.scan.onConnectionChange(true);
  await assert.rejects(
    run.scan.callback('native-session'),
    error => error === failure,
  );
  run.scan.onError(failure);
  assert.deepEqual(run.scan.getCloseOptions(), {waitForRemoval: true});
  run.scan.onConnectionChange(false);

  assert.equal(presenter.current.error, true);
  assert.equal(presenter.current.scanning, false);
  assert.equal(presenter.current.closing, false);
  assert.equal(run.scan.stopCalls, 0);
  assert.equal(run.settled, false);

  presenter.current.onDismiss();
  run.scan.stopped.resolve();
  hide(presenter);
  assert.equal((await run.promise).error.code, 'CANCELLED');
});

for (const known of [true, false]) {
  for (const targetPlatform of ['android', 'ios']) {
    test(`${targetPlatform}: ${known ? 'known' : 'unexpected'} raw card errors are suppressed only after being shown and without needing details`, async () => {
      platform = targetPlatform;
      const {presenter, start, presentedErrors} = setup();
      const failure = known
        ? new MonoidCardError('Wrong card')
        : new Error('INSTALL failed');
      const run = start(async () => {
        throw failure;
      });
      await connect(run.scan);
      assert.deepEqual(
        presentedErrors,
        known && targetPlatform === 'android' ? [failure] : [],
      );
      if (targetPlatform === 'android') {
        assert.equal(presenter.current.content, failure.message);
      }
      run.scan.stopped.resolve();
      hide(presenter);
      assert.equal((await run.promise).error, failure);
    });
  }
}

test('success waits for native stop and shared presentation exit', async () => {
  const {presenter, start} = setup();
  const pending = deferred();
  const run = start(async (sessionId, setContent) => {
    assert.equal(sessionId, 'native-session');
    setContent('Installing 40%');
    await pending.promise;
  });
  const connected = connect(run.scan);
  assert.equal(presenter.current.scanning, true);
  assert.equal(presenter.current.content, 'Installing 40%');
  pending.resolve();
  await connected;
  assert.equal(presenter.current.content, '');
  assert.deepEqual(run.scan.closeOptions, {});
  assert.equal(presenter.current.closing, true);
  assert.equal(run.scan.stopCalls, 1);
  run.scan.stopped.resolve();
  await setImmediate();
  assert.equal(run.settled, false);
  hide(presenter);
  assert.deepEqual(await run.promise, {success: true});
});

test('presentation exit cannot resolve success before native cleanup', async () => {
  const {presenter, start} = setup();
  const run = start(async () => {});
  await connect(run.scan);
  hide(presenter);
  await setImmediate();
  assert.equal(run.settled, false);
  run.scan.stopped.resolve();
  assert.deepEqual(await run.promise, {success: true});
});

test('dismissal waits for outstanding callback and ignores its late progress', async () => {
  platform = 'ios';
  const {presenter, start} = setup();
  const callback = deferred();
  let lateContent;
  let signal;
  const run = start(async (_sessionId, setContent, scanSignal) => {
    lateContent = setContent;
    signal = scanSignal;
    await callback.promise;
  });
  const connected = connect(run.scan);
  assert.equal(signal.aborted, false);
  presenter.current.onDismiss();
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.code, 'CANCELLED');
  assert.equal(run.scan.stopCalls, 0);
  lateContent('Late progress');
  assert.equal(presenter.current.content, 'Hold card');
  hide(presenter);
  run.scan.stopped.resolve();
  await setImmediate();
  assert.equal(run.settled, false);
  callback.resolve();
  await connected;
  assert.deepEqual(run.scan.closeOptions, {});
  assert.equal((await run.promise).error.code, 'CANCELLED');
  assert.equal(run.scan.stopCalls, 1);
});

test('unmount aborts pending callback work before native stop completes', async () => {
  platform = 'ios';
  const {presenter, owner, start} = setup();
  const pendingRead = deferred();
  let signal;
  let continued = false;
  const run = start(async (_sessionId, _setContent, scanSignal) => {
    signal = scanSignal;
    await pendingRead.promise;
    signal.throwIfAborted();
    continued = true;
  });
  const connected = connect(run.scan);

  owner.unmount();
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.code, 'CANCELLED');
  pendingRead.resolve();
  await connected;
  assert.deepEqual(run.scan.closeOptions, {});
  assert.equal(continued, false);
  assert.equal(run.settled, false);
  run.scan.stopped.resolve();
  hide(presenter);
  assert.equal((await run.promise).error.code, 'CANCELLED');
});

test('native tag loss aborts pending callback work without waiting for its response', async () => {
  platform = 'ios';
  const {presenter, start} = setup();
  const pendingRead = deferred();
  let signal;
  const run = start(async (_sessionId, _setContent, scanSignal) => {
    signal = scanSignal;
    await pendingRead.promise;
    signal.throwIfAborted();
  });
  const connected = connect(run.scan);

  run.scan.onError(Object.assign(new Error('Card lost'), {code: 'TAG_LOST'}));
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.code, 'CANCELLED');
  pendingRead.resolve();
  await connected;
  assert.deepEqual(run.scan.closeOptions, {});
  assert.notEqual(presenter.current.content, '');
  run.scan.stopped.resolve();
  hide(presenter);
  assert.equal((await run.promise).error, signal.reason);
  assert.equal(run.scan.waitingForRemoval, false);
});

test('tag loss closes quietly and does not retry', async () => {
  const {presenter, start, scans} = setup();
  const run = start(async () => {
    throw Object.assign(new Error('Card lost'), {code: 'TAG_LOST'});
  });
  await connect(run.scan);
  run.scan.stopped.resolve();
  hide(presenter);
  assert.equal((await run.promise).error.code, 'CANCELLED');
  assert.equal(scans.length, 1);
});

test('stop failure takes priority over operation failure and still waits for exit', async () => {
  const {presenter, start} = setup();
  const run = start(async () => {
    throw new Error('INSTALL failed');
  });
  await connect(run.scan);
  const stopError = new Error('Native cleanup failed');
  run.scan.stopped.reject(stopError);
  await setImmediate();
  assert.equal(run.settled, false);
  hide(presenter);
  assert.equal((await run.promise).error, stopError);
});

test('unmount cancels and prevents late native events from reopening the prompt', async () => {
  const {presenter, owner, start} = setup();
  let callbacks = 0;
  const run = start(async () => {
    callbacks++;
  });
  owner.unmount();
  await connect(run.scan);
  assert.equal(callbacks, 0);
  assert.equal(presenter.current.closing, true);
  run.scan.stopped.resolve();
  hide(presenter);
  assert.equal((await run.promise).error.code, 'CANCELLED');
});

test('a replacement presentation prevents the old scan from reporting success', async () => {
  const {presenter, start} = setup();
  const run = start(async () => {});
  await connect(run.scan);
  const replacement = Symbol();
  presenter.show(replacement, {
    scanning: false,
    content: 'Another task',
    onDismiss() {},
  });
  run.scan.stopped.resolve();
  assert.equal((await run.promise).error.code, 'CANCELLED');
  assert.equal(presenter.current.owner, replacement);
});

test('another scan is blocked until cleanup ends and then can start explicitly', async () => {
  const {presenter, start, scans} = setup();
  const first = start(async () => {});
  presenter.current.onDismiss();
  const premature = start(async () => {});
  assert.match((await premature.promise).error.message, /already running/);
  assert.equal(scans.length, 1);
  first.scan.stopped.resolve();
  hide(presenter);
  assert.equal((await first.promise).error.code, 'CANCELLED');

  const second = start(async () => {});
  assert.equal(scans.length, 2);
  await connect(second.scan);
  second.scan.stopped.resolve();
  hide(presenter);
  assert.deepEqual(await second.promise, {success: true});
});
