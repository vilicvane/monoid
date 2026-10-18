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
    backend: {
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
        state.calls.push('cancel');
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
