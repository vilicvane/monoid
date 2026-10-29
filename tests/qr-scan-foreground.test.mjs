import assert from 'node:assert/strict';
import {after, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

let app;
mock.module('@capacitor/app', {
  namedExports: {
    App: {
      addListener: (...args) => app.addListener(...args),
      getState: () => app.getState(),
    },
  },
});

const {QrScanForeground} = await import('../.bld/app/@lib/qr-scanner.js');
const originalDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  'document',
);
after(() => {
  if (originalDocument) {
    Object.defineProperty(globalThis, 'document', originalDocument);
  } else {
    delete globalThis.document;
  }
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return {promise, resolve, reject};
}

async function setup({active = true, hidden = false, ...overrides} = {}) {
  const document = Object.assign(new EventTarget(), {hidden});
  globalThis.document = document;
  const state = {resumes: 0, errors: [], removals: 0};
  app = {
    async addListener(name, callback) {
      assert.equal(name, 'appStateChange');
      state.activate = isActive => callback({isActive});
      return {remove: async () => state.removals++};
    },
    getState: async () => ({isActive: active}),
    ...overrides,
  };
  state.hide = hidden => {
    document.hidden = hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  state.coordinator = new QrScanForeground(error => state.errors.push(error));
  state.request = (ready = Promise.resolve(), eligible = () => true) =>
    state.coordinator.requestResume(ready, eligible, () => state.resumes++);
  await setImmediate();
  return state;
}

for (const pauseFirst of [true, false]) {
  test(`foreground ${pauseFirst ? 'after' : 'before'} scanEnded resumes once after cleanup`, async () => {
    const state = await setup();
    const cleanup = deferred();
    try {
      state.activate(false);
      state.hide(true);
      if (pauseFirst) state.request(cleanup.promise);
      state.activate(true);
      state.hide(false);
      if (!pauseFirst) state.request(cleanup.promise);
      await setImmediate();
      assert.equal(state.resumes, 0);
      cleanup.resolve();
      await setImmediate();
      assert.equal(state.resumes, 1);
      state.activate(true);
      state.hide(false);
      assert.equal(state.resumes, 1);
    } finally {
      state.coordinator.dispose();
    }
  });
}

test('a stale active snapshot permits one recovery, then waits for a new foreground transition', async () => {
  const state = await setup();
  try {
    state.request();
    await setImmediate();
    assert.equal(state.resumes, 1);
    state.request();
    await setImmediate();
    state.activate(true);
    state.hide(false);
    assert.equal(state.resumes, 1);
    state.activate(false);
    state.activate(true);
    assert.equal(state.resumes, 2);
  } finally {
    state.coordinator.dispose();
  }
});

test('foreground completion works after camera recovery without consuming or resetting its allowance', async () => {
  for (const recovered of [false, true]) {
    const state = await setup();
    let deliveries = 0;
    try {
      if (recovered) {
        state.request();
        await setImmediate();
        assert.equal(state.resumes, 1);
      }
      state.coordinator.waitForForeground(
        Promise.resolve(),
        () => true,
        () => deliveries++,
      );
      await setImmediate();
      assert.equal(deliveries, 1);
      state.request();
      await setImmediate();
      assert.equal(state.resumes, 1);
      state.activate(true);
      assert.equal(deliveries, 1);
      state.activate(false);
      state.activate(true);
      assert.equal(state.resumes, recovered ? 2 : 1);
      assert.equal(deliveries, 1);
    } finally {
      state.coordinator.dispose();
    }
  }
});

for (const cleanupFirst of [true, false]) {
  test(`foreground completion waits for ${cleanupFirst ? 'activation after cleanup' : 'cleanup after activation'}`, async () => {
    const state = await setup({active: false});
    const cleanup = deferred();
    let deliveries = 0;
    try {
      state.coordinator.waitForForeground(
        cleanup.promise,
        () => true,
        () => deliveries++,
      );
      if (cleanupFirst) cleanup.resolve();
      else state.activate(true);
      await setImmediate();
      assert.equal(deliveries, 0);
      if (cleanupFirst) state.activate(true);
      else cleanup.resolve();
      await setImmediate();
      assert.equal(deliveries, 1);
      state.activate(false);
      state.activate(true);
      assert.equal(deliveries, 1);
    } finally {
      state.coordinator.dispose();
    }
  });
}

test('foreground completion is suppressed by cancellation, disposal, lost eligibility or failed cleanup', async () => {
  for (const action of ['cancel', 'dispose', 'ineligible', 'failure']) {
    const state = await setup({active: false});
    const cleanup = deferred();
    let deliveries = 0;
    let eligible = true;
    try {
      const cancel = state.coordinator.waitForForeground(
        cleanup.promise,
        () => eligible,
        () => deliveries++,
      );
      if (action === 'cancel') cancel();
      else if (action === 'dispose') state.coordinator.dispose();
      else if (action === 'ineligible') eligible = false;
      if (action === 'failure') cleanup.reject(new Error('Camera still owned'));
      else cleanup.resolve();
      await setImmediate();
      state.activate(true);
      assert.equal(deliveries, 0);
      assert.deepEqual(state.errors, []);
    } finally {
      state.coordinator.dispose();
    }
  }
});

test('document visibility and native activation must both be ready', async () => {
  const state = await setup({active: false, hidden: true});
  try {
    state.request();
    await setImmediate();
    state.activate(true);
    assert.equal(state.resumes, 0);
    state.hide(false);
    assert.equal(state.resumes, 1);
    state.activate(false);
    state.request();
    await setImmediate();
    state.hide(true);
    state.hide(false);
    assert.equal(state.resumes, 1);
    state.activate(true);
    assert.equal(state.resumes, 2);
  } finally {
    state.coordinator.dispose();
  }
});

test('leaving or accepting a result during cleanup prevents recovery', async () => {
  const state = await setup();
  const cleanup = deferred();
  let eligible = true;
  try {
    state.request(cleanup.promise, () => eligible);
    eligible = false;
    cleanup.resolve();
    await setImmediate();
    state.activate(false);
    state.activate(true);
    assert.equal(state.resumes, 0);
  } finally {
    state.coordinator.dispose();
  }
});

test('a failed cleanup never reopens the camera', async () => {
  const state = await setup();
  try {
    state.request(Promise.reject(new Error('Camera still owned')));
    await setImmediate();
    state.activate(false);
    state.activate(true);
    assert.equal(state.resumes, 0);
    // The scanner caller owns reporting its stop failure.
    assert.deepEqual(state.errors, []);
  } finally {
    state.coordinator.dispose();
  }
});

test('an old cancellation cannot erase a newer pending attempt', async () => {
  const state = await setup({active: false});
  try {
    const oldCleanup = deferred();
    const cancelOld = state.request(oldCleanup.promise);
    state.request();
    cancelOld();
    oldCleanup.resolve();
    await setImmediate();
    state.activate(true);
    assert.equal(state.resumes, 1);
  } finally {
    state.coordinator.dispose();
  }
});

for (const action of ['cancel', 'dispose']) {
  test(`${action} while stopping suppresses recovery`, async () => {
    const state = await setup();
    const cleanup = deferred();
    const cancel = state.request(cleanup.promise);
    if (action === 'cancel') cancel();
    else state.coordinator.dispose();
    cleanup.resolve();
    await setImmediate();
    state.activate(false);
    state.activate(true);
    assert.equal(state.resumes, 0);
    if (action === 'cancel') state.coordinator.dispose();
    assert.equal(state.removals, 1);
  });
}

test('a delayed initial state cannot overwrite a newer background event', async () => {
  const snapshot = deferred();
  const state = await setup({getState: () => snapshot.promise});
  try {
    state.activate(false);
    state.request();
    snapshot.resolve({isActive: true});
    await setImmediate();
    assert.equal(state.resumes, 0);
    state.activate(true);
    assert.equal(state.resumes, 1);
  } finally {
    state.coordinator.dispose();
  }
});

test('disposing before native listener registration removes the late listener', async () => {
  const registration = deferred();
  let removals = 0;
  let snapshots = 0;
  const state = await setup({
    addListener: () => registration.promise,
    getState: async () => {
      snapshots++;
      return {isActive: true};
    },
  });
  state.coordinator.dispose();
  registration.resolve({remove: async () => removals++});
  await setImmediate();
  assert.equal(removals, 1);
  assert.equal(snapshots, 0);
  assert.deepEqual(state.errors, []);
});
