import assert from 'node:assert/strict';
import {mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

mock.module('capacitor-biometric-vault', {
  namedExports: {BiometricVault: {}},
});

const {MonoidCredentialsStore} = await import(
  '../.bld/app/@services/monoid-credentials-store.js'
);

const CARD = '01020304';
const OTHER_CARD = '05060708';
const THIRD_CARD = '090a0b0c';
const PIN = 'Test PIN 1';
const OTHER_PIN = 'Test PIN 2';

function fixture(pins = {}) {
  const state = {
    value: JSON.stringify(pins),
    calls: [],
    authentications: [],
    disposals: 0,
    backend: {
      async authenticate(options) {
        state.authentications.push(options);
        await state.onAuthenticate?.();
        const cancel = () => state.calls.push('close');
        options.signal?.addEventListener('abort', cancel, {once: true});
        return {
          get: options => state.backend.get(options),
          set: options => state.backend.set(options),
          remove: options => state.backend.remove(options),
          [Symbol.asyncDispose]: async () => {
            options.signal?.removeEventListener('abort', cancel);
            state.disposals++;
            await state.onDispose?.();
          },
        };
      },
      async get() {
        state.calls.push('get');
        await state.onGet?.();
        return {value: state.value};
      },
      async set({value}) {
        state.calls.push('set');
        await state.onSet?.(value);
        state.value = value;
      },
      async remove() {
        state.calls.push('remove');
        state.value = null;
      },
      async clear() {
        state.calls.push('clear');
        state.value = null;
      },
      async cancel() {
        state.calls.push('close');
      },
    },
  };

  state.store = new MonoidCredentialsStore(state.backend);
  return state;
}

function assertSaved(state, expected) {
  const saved = JSON.parse(state.value ?? '{}');
  assert.deepEqual(Object.keys(saved).sort(), Object.keys(expected).sort());
  for (const id of Object.keys(expected)) {
    assert.ok(saved[id] === expected[id], `Credential for ${id} is preserved`);
  }
}

for (const initial of [{}, {[CARD]: PIN}]) {
  test(`a fresh ${Object.keys(initial).length ? 'populated' : 'empty'} snapshot needs only the initial read and authenticated write`, async () => {
    const state = fixture(initial);
    const snapshot = await state.store.getPINs();

    assert.ok(Object.isFrozen(snapshot));
    await state.store.setPIN(OTHER_CARD, OTHER_PIN, undefined, snapshot);

    assert.deepEqual(state.calls, ['get', 'set']);
    assert.deepEqual(Object.keys(snapshot), Object.keys(initial));
    assertSaved(state, {...initial, [OTHER_CARD]: OTHER_PIN});
  });
}

test('a write through another store invalidates the snapshot and preserves both updates', async () => {
  const state = fixture({[CARD]: PIN});
  const otherStore = new MonoidCredentialsStore(state.backend);
  const snapshot = await state.store.getPINs();

  await otherStore.setPIN(OTHER_CARD, OTHER_PIN);
  await state.store.setPIN(THIRD_CARD, PIN, undefined, snapshot);

  assert.deepEqual(state.calls, ['get', 'get', 'set', 'get', 'set']);
  assertSaved(state, {[CARD]: PIN, [OTHER_CARD]: OTHER_PIN, [THIRD_CARD]: PIN});
});

for (const mutation of ['remove-one', 'remove-final', 'clear']) {
  test(`${mutation} invalidates snapshots so deleted credentials are not restored`, async () => {
    const initial =
      mutation === 'remove-one'
        ? {[CARD]: PIN, [OTHER_CARD]: OTHER_PIN}
        : {[CARD]: PIN};
    const state = fixture(initial);
    const snapshot = await state.store.getPINs();

    if (mutation === 'clear') {
      await state.store.clear();
    } else {
      await state.store.removePIN(CARD, PIN);
    }
    state.calls.length = 0;
    await state.store.setPIN(THIRD_CARD, PIN, undefined, snapshot);

    assert.deepEqual(state.calls, ['get', 'set']);
    assertSaved(state, {
      ...(mutation === 'remove-one' ? {[OTHER_CARD]: OTHER_PIN} : {}),
      [THIRD_CARD]: PIN,
    });
  });
}

test('queued writes validate snapshot freshness when their queue operation starts', async () => {
  const state = fixture();
  const snapshot = await state.store.getPINs();
  let release;
  const held = new Promise(resolve => {
    release = resolve;
  });
  state.onSet = () => held;

  const first = state.store.setPIN(CARD, PIN, undefined, snapshot);
  const second = state.store.setPIN(OTHER_CARD, OTHER_PIN, undefined, snapshot);

  try {
    await setImmediate();
    assert.deepEqual(state.calls, ['get', 'set']);
  } finally {
    release();
    await Promise.all([first, second]);
  }

  assert.deepEqual(state.calls, ['get', 'set', 'get', 'set']);
  assertSaved(state, {[CARD]: PIN, [OTHER_CARD]: OTHER_PIN});
});

test('a fallback empty map from corrupted storage cannot overwrite inaccessible credentials', async () => {
  const state = fixture();
  state.value = 'invalid stored document';
  const snapshot = await state.store.getPINs();

  assert.deepEqual(snapshot, {});
  await assert.rejects(state.store.setPIN(CARD, PIN, undefined, snapshot), {
    code: 'DATA_CORRUPTED',
  });

  assert.deepEqual(state.calls, ['get', 'get']);
  assert.equal(state.value, 'invalid stored document');
});

test('an unavailable read fallback is reread after recovery and preserves existing credentials', async () => {
  const state = fixture({[CARD]: PIN});
  state.onGet = () => {
    throw {code: 'BIOMETRIC_UNAVAILABLE'};
  };
  const snapshot = await state.store.getPINs();
  state.onGet = undefined;

  await state.store.setPIN(OTHER_CARD, OTHER_PIN, undefined, snapshot);

  assert.deepEqual(state.calls, ['get', 'get', 'set']);
  assertSaved(state, {[CARD]: PIN, [OTHER_CARD]: OTHER_PIN});
});

test('a cancelled operation cannot write through its otherwise fresh snapshot', async () => {
  const state = fixture({[CARD]: PIN});
  const owner = new AbortController();
  const snapshot = await state.store.getPINs(owner.signal);
  owner.abort();

  await assert.rejects(
    state.store.setPIN(OTHER_CARD, OTHER_PIN, owner.signal, snapshot),
    {code: 'CANCELLED'},
  );

  assert.deepEqual(state.calls, ['get']);
  assertSaved(state, {[CARD]: PIN});
});

test('a snapshot from an aborted owner requires a fresh read for a new owner', async () => {
  const state = fixture({[CARD]: PIN});
  const previousOwner = new AbortController();
  const snapshot = await state.store.getPINs(previousOwner.signal);
  previousOwner.abort();
  const nextOwner = new AbortController();

  await state.store.setPIN(OTHER_CARD, OTHER_PIN, nextOwner.signal, snapshot);

  assert.deepEqual(state.calls, ['get', 'get', 'set']);
  assertSaved(state, {[CARD]: PIN, [OTHER_CARD]: OTHER_PIN});
});

test('a failed write invalidates snapshots even when the backend may have committed', async () => {
  const state = fixture({[CARD]: PIN});
  const snapshot = await state.store.getPINs();
  state.onSet = value => {
    state.value = value;
    throw {code: 'IO_ERROR'};
  };

  await assert.rejects(
    state.store.setPIN(OTHER_CARD, OTHER_PIN, undefined, snapshot),
    {code: 'IO_ERROR'},
  );
  state.onSet = undefined;
  await state.store.setPIN(THIRD_CARD, PIN, undefined, snapshot);

  assert.deepEqual(state.calls, ['get', 'set', 'get', 'set']);
  assertSaved(state, {[CARD]: PIN, [OTHER_CARD]: OTHER_PIN, [THIRD_CARD]: PIN});
});

for (const kind of ['foreign', 'cloned', 'forged']) {
  test(`${kind} snapshots require a new authenticated read`, async () => {
    const state = fixture({[CARD]: PIN});
    const foreign = fixture();
    const snapshot =
      kind === 'foreign'
        ? await foreign.store.getPINs()
        : kind === 'cloned'
          ? Object.freeze({...(await state.store.getPINs())})
          : Object.freeze({});
    state.calls.length = 0;

    await state.store.setPIN(OTHER_CARD, OTHER_PIN, undefined, snapshot);

    assert.deepEqual(state.calls, ['get', 'set']);
    assertSaved(state, {[CARD]: PIN, [OTHER_CARD]: OTHER_PIN});
  });
}

test('a page PIN session reuses one unlock across cards and scan cleanup', async () => {
  const state = fixture({[CARD]: PIN, [OTHER_CARD]: OTHER_PIN});
  const session = state.store.createPINSession();

  for (const id of [CARD, OTHER_CARD, CARD]) {
    const scan = new AbortController();
    const pins = await session.getPINs(scan.signal);
    assert.ok(pins[id] !== undefined);
    scan.abort();
  }

  assert.deepEqual(state.calls, ['get']);
  session.clear();
  session.clear();
  await session.getPINs();
  assert.deepEqual(state.calls, ['get', 'close', 'get']);
  assert.equal(state.authentications.length, 2);
});

test('explicit preauthorization, reset credential removal and new PIN save share one access', async () => {
  const state = fixture({[CARD]: PIN, [OTHER_CARD]: OTHER_PIN});
  const session = state.store.createPINSession();
  await session.authenticate();
  assert.equal(state.authentications.length, 1);
  assert.equal(state.authentications[0].reason, 'Unlock Access PINs');
  assert.deepEqual(state.calls, []);

  await session.removePIN(CARD);
  assert.deepEqual(await session.getPINs(), {[OTHER_CARD]: OTHER_PIN});
  assertSaved(state, {[OTHER_CARD]: OTHER_PIN});
  await session.setPIN(CARD, 'Replacement PIN');

  assert.deepEqual(state.calls, ['get', 'set', 'set']);
  assert.equal(state.authentications.length, 1);
  assertSaved(state, {[CARD]: 'Replacement PIN', [OTHER_CARD]: OTHER_PIN});
  assert.deepEqual(await session.getPINs(), {
    [CARD]: 'Replacement PIN',
    [OTHER_CARD]: OTHER_PIN,
  });
  await session[Symbol.asyncDispose]();
  assert.equal(state.disposals, 1);
  assert.equal(state.authentications[0].signal.aborted, true);
});

test('unconditional removal clears the cached target while preserving other local PIN changes', async () => {
  const state = fixture({[CARD]: PIN, [OTHER_CARD]: OTHER_PIN});
  const session = state.store.createPINSession();
  await session.getPINs();
  session.rememberPIN(CARD, 'Unsaved target PIN');
  session.rememberPIN(THIRD_CARD, 'Unsaved other PIN');
  session.forgetPIN(OTHER_CARD, OTHER_PIN);

  await session.removePIN(CARD);

  assert.deepEqual(await session.getPINs(), {
    [THIRD_CARD]: 'Unsaved other PIN',
  });
  assertSaved(state, {[OTHER_CARD]: OTHER_PIN});
  assert.equal(session.hasUnsavedPIN(THIRD_CARD, 'Unsaved other PIN'), true);
  await session[Symbol.asyncDispose]();
});

test('conditional removal preserves a different manually entered PIN in the session', async () => {
  const state = fixture({[CARD]: PIN, [OTHER_CARD]: OTHER_PIN});
  const session = state.store.createPINSession();
  await session.getPINs();
  session.rememberPIN(CARD, 'New manual PIN');

  await session.removePIN(CARD, PIN);

  assertSaved(state, {[OTHER_CARD]: OTHER_PIN});
  assert.deepEqual(await session.getPINs(), {
    [CARD]: 'New manual PIN',
    [OTHER_CARD]: OTHER_PIN,
  });
  assert.equal(session.hasUnsavedPIN(CARD, 'New manual PIN'), true);
  await session[Symbol.asyncDispose]();
});

test('conditional removal retains a concurrently changed saved PIN and refreshes the stale cached target', async () => {
  const state = fixture({[CARD]: PIN, [OTHER_CARD]: OTHER_PIN});
  const session = state.store.createPINSession();
  await session.getPINs();
  await new MonoidCredentialsStore(state.backend).setPIN(CARD, 'New saved PIN');
  state.calls.length = 0;

  await session.removePIN(CARD, PIN);

  assert.deepEqual(state.calls, ['get']);
  assertSaved(state, {[CARD]: 'New saved PIN', [OTHER_CARD]: OTHER_PIN});
  assert.deepEqual(await session.getPINs(), {
    [CARD]: 'New saved PIN',
    [OTHER_CARD]: OTHER_PIN,
  });
  await session[Symbol.asyncDispose]();
});

for (const code of ['BIOMETRIC_UNAVAILABLE', 'CANCELLED']) {
  test(`explicit preauthorization propagates ${code} without manual-PIN fallback or implicit retry`, async () => {
    const state = fixture({[CARD]: PIN});
    const session = state.store.createPINSession();
    state.onAuthenticate = () => {
      throw {code, message: 'private native details'};
    };
    await assert.rejects(session.authenticate(), error => {
      assert.equal(error.code, code);
      assert.equal(error.message.includes('private'), false);
      return true;
    });
    state.onAuthenticate = undefined;
    await assert.rejects(session.authenticate(), {code});
    assert.equal(state.authentications.length, 1);
    assert.deepEqual(state.calls, []);
    session.clear();
    await session.authenticate();
    assert.equal(state.authentications.length, 2);
    await session[Symbol.asyncDispose]();
  });
}

test('cancelling preauthorization disposes a late access and does not read or mutate stored PINs', async () => {
  const state = fixture({[CARD]: PIN});
  const session = state.store.createPINSession();
  const pending = Promise.withResolvers();
  state.onAuthenticate = () => pending.promise;
  const operation = new AbortController();
  const rejected = assert.rejects(session.authenticate(operation.signal), {
    code: 'CANCELLED',
  });
  await setImmediate();
  operation.abort();
  pending.resolve();
  await rejected;
  await session[Symbol.asyncDispose]();
  assert.equal(state.disposals, 1);
  assert.deepEqual(state.calls, []);
  assertSaved(state, {[CARD]: PIN});
});

test('manual PIN saves refresh the page snapshot without another unlock', async () => {
  const state = fixture({[CARD]: PIN});
  const session = state.store.createPINSession();
  const firstScan = new AbortController();
  await session.getPINs(firstScan.signal);
  firstScan.abort();

  for (const id of [OTHER_CARD, THIRD_CARD]) {
    const scan = new AbortController();
    await session.getPINs(scan.signal);
    session.rememberPIN(id, OTHER_PIN);
    await session.setPIN(id, OTHER_PIN, scan.signal);
    scan.abort();
  }

  assert.deepEqual(state.calls, ['get', 'set', 'set']);
  assertSaved(state, {
    [CARD]: PIN,
    [OTHER_CARD]: OTHER_PIN,
    [THIRD_CARD]: OTHER_PIN,
  });
  session.clear();
});

test('a rejected PIN stays excluded from the page after its storage removal fails', async () => {
  const state = fixture({[CARD]: PIN, [OTHER_CARD]: OTHER_PIN});
  const session = state.store.createPINSession();
  await session.getPINs();
  session.forgetPIN(CARD, PIN);
  state.onSet = () => {
    throw {code: 'IO_ERROR'};
  };

  await assert.rejects(session.removePIN(CARD, PIN), {code: 'IO_ERROR'});
  assert.equal((await session.getPINs())[CARD], undefined);
  assert.ok((await session.getPINs())[OTHER_CARD] === OTHER_PIN);
  assert.deepEqual(state.calls, ['get', 'set']);
  session.clear();
});

test('a page PIN session preserves unrelated concurrent changes on its next save', async () => {
  const state = fixture({[CARD]: PIN});
  const session = state.store.createPINSession();
  await session.getPINs();
  await new MonoidCredentialsStore(state.backend).setPIN(OTHER_CARD, OTHER_PIN);
  session.rememberPIN(THIRD_CARD, PIN);
  await session.setPIN(THIRD_CARD, PIN);

  assert.deepEqual(state.calls, ['get', 'get', 'set', 'get', 'set']);
  assertSaved(state, {[CARD]: PIN, [OTHER_CARD]: OTHER_PIN, [THIRD_CARD]: PIN});
  session.clear();
});

test('an interrupted read can be retried within the same authorization', async () => {
  const state = fixture({[CARD]: PIN});
  const session = state.store.createPINSession();
  state.onGet = () => {
    throw {code: 'CANCELLED'};
  };
  await assert.rejects(session.getPINs(), {code: 'CANCELLED'});
  state.onGet = undefined;
  assert.ok((await session.getPINs())[CARD] === PIN);
  assert.deepEqual(state.calls, ['get', 'get']);
  session.clear();
});

test('clear cancels an in-flight page unlock and a late result cannot refill it', async () => {
  const state = fixture({[CARD]: PIN});
  const session = state.store.createPINSession();
  let release;
  state.onGet = () =>
    new Promise(resolve => {
      release = resolve;
    });
  const reading = session.getPINs();
  const rejected = assert.rejects(reading, {code: 'CANCELLED'});
  await setImmediate();

  session.clear();
  state.onGet = undefined;
  state.value = JSON.stringify({[OTHER_CARD]: OTHER_PIN});
  const next = session.getPINs();
  release();
  await rejected;
  const pins = await next;

  assert.equal(pins[CARD], undefined);
  assert.ok(pins[OTHER_CARD] === OTHER_PIN);
  await session.getPINs();
  assert.deepEqual(state.calls, ['get', 'close', 'get']);
  session.clear();
});

test('cancelling a scan during page unlock cancels the request and allows a later scan', async () => {
  const state = fixture({[CARD]: PIN});
  const session = state.store.createPINSession();
  let release;
  state.onGet = () =>
    new Promise(resolve => {
      release = resolve;
    });
  const scan = new AbortController();
  const rejected = assert.rejects(session.getPINs(scan.signal), {
    code: 'CANCELLED',
  });
  await setImmediate();
  scan.abort();
  release();
  await rejected;

  state.onGet = undefined;
  assert.ok((await session.getPINs())[CARD] === PIN);
  assert.deepEqual(state.calls, ['get', 'close', 'get']);
  session.clear();
});

test('a cleared page cannot refill its snapshot when an in-flight write commits late', async () => {
  const state = fixture({[CARD]: PIN});
  const session = state.store.createPINSession();
  await session.getPINs();
  session.rememberPIN(OTHER_CARD, OTHER_PIN);
  let release;
  state.onSet = () =>
    new Promise(resolve => {
      release = resolve;
    });
  const saving = session.setPIN(OTHER_CARD, OTHER_PIN);
  await setImmediate();

  session.clear();
  const next = session.getPINs();
  release();
  await saving;
  const pins = await next;
  assert.ok(pins[OTHER_CARD] === OTHER_PIN);
  await session.getPINs();
  assert.deepEqual(state.calls, ['get', 'set', 'close', 'get']);
  session.clear();
});

for (const code of ['BIOMETRIC_UNAVAILABLE', 'CANCELLED']) {
  test(`a failed authorization (${code}) is not renewed at save`, async () => {
    const state = fixture({[CARD]: PIN});
    const session = state.store.createPINSession();
    state.onAuthenticate = () => {
      throw {code};
    };
    if (code === 'BIOMETRIC_UNAVAILABLE') {
      assert.deepEqual(await session.getPINs(), {});
    } else {
      await assert.rejects(session.getPINs(), {code});
    }
    state.onAuthenticate = undefined;
    await assert.rejects(session.setPIN(OTHER_CARD, OTHER_PIN), {code});
    assert.equal(state.authentications.length, 1);
    assertSaved(state, {[CARD]: PIN});
    session.clear();
    await session.setPIN(OTHER_CARD, OTHER_PIN);
    assert.equal(state.authentications.length, 2);
    await session[Symbol.asyncDispose]();
  });
}

test('expired authorization fails a save without another prompt or replay', async () => {
  const state = fixture({[CARD]: PIN});
  const session = state.store.createPINSession();
  await session.getPINs();
  state.onSet = () => {
    throw {code: 'AUTHORIZATION_EXPIRED'};
  };
  await assert.rejects(session.setPIN(OTHER_CARD, OTHER_PIN), {
    code: 'AUTHORIZATION_EXPIRED',
  });
  await assert.rejects(session.setPIN(OTHER_CARD, OTHER_PIN), {
    code: 'AUTHORIZATION_EXPIRED',
  });
  assert.equal(state.authentications.length, 1);
  assertSaved(state, {[CARD]: PIN});
  await session[Symbol.asyncDispose]();
});

test('a session first used for saving lazily acquires one authorization for its read and write', async () => {
  const state = fixture({[CARD]: PIN});
  const session = state.store.createPINSession();
  assert.equal(state.authentications.length, 0);
  await session.setPIN(OTHER_CARD, OTHER_PIN);
  assert.equal(state.authentications.length, 1);
  assert.deepEqual(state.calls, ['get', 'set']);
  assertSaved(state, {[CARD]: PIN, [OTHER_CARD]: OTHER_PIN});
  await session[Symbol.asyncDispose]();
  assert.equal(state.disposals, 1);
});

test('disposal waits for every generation even if a previous cleanup failed', async () => {
  const state = fixture({[CARD]: PIN});
  const session = state.store.createPINSession();
  await session.getPINs();
  state.onDispose = () => {
    throw new Error('secret native cleanup payload');
  };
  session.clear();
  await setImmediate();
  await session.getPINs();
  const cleanup = Promise.withResolvers();
  state.onDispose = () => cleanup.promise;
  let settled = false;
  const disposing = session[Symbol.asyncDispose]().finally(() => {
    settled = true;
  });
  const rejected = assert.rejects(disposing, error => {
    assert.equal(error.code, 'IO_ERROR');
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
  await setImmediate();
  assert.equal(settled, false);
  cleanup.resolve();
  await rejected;
  assert.equal(state.disposals, 2);
});
