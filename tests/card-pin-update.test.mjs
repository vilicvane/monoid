import assert from 'node:assert/strict';
import {test} from 'node:test';

import {updateCardPIN} from '../.bld/app/@components/views/safe/card-pin-update.js';
import {CBORAppletError} from '../.bld/app/@lib/cbor-applet.js';
import {MonoidWrongCardError} from '../.bld/app/@lib/monoid/card-error.js';
import {MonoidPINSession} from '../.bld/app/@services/monoid-credentials-store.js';

const bytes = value => Uint8Array.from(Buffer.from(value, 'hex'));
const card = {id: 'aabbccdd', publicKey: `04${'12'.repeat(64)}`};
const hello = {
  version: 0,
  id: bytes(card.id),
  publicKey: bytes(card.publicKey),
  bundle: false,
  pins: {access: 5, safe: 5},
};
const oldPIN = 'old-pin',
  newPIN = 'new-pin';
function fixture() {
  const calls = [];
  const controller = new AbortController();
  const applet = {
    authenticate: async request => {
      calls.push(['authenticate', request]);
    },
    setPIN: async request => {
      calls.push(['setPIN', request]);
    },
  };
  const run = (kind = 'Access', currentHello = hello) =>
    updateCardPIN(
      applet,
      currentHello,
      card,
      kind,
      oldPIN,
      newPIN,
      controller.signal,
    );
  return {calls, controller, applet, run};
}

for (const kind of ['Access', 'Safe']) {
  test(`${kind} PIN update authenticates with current Safe PIN and returns the Identity ID`, async () => {
    const state = fixture();
    assert.equal(await state.run(kind), card.id);
    assert.deepEqual(state.calls, [
      ['authenticate', {safe: true, pin: oldPIN}],
      ['setPIN', {pin: newPIN, ...(kind === 'Safe' && {safe: true})}],
    ]);
  });
}

test('a different full Safe identity is rejected before any credential is sent', async () => {
  const state = fixture();
  await assert.rejects(
    state.run('Access', {
      ...hello,
      publicKey: bytes(`04${'34'.repeat(64)}`),
    }),
    MonoidWrongCardError,
  );
  assert.deepEqual(state.calls, []);
});

for (const tries of [4, 0]) {
  test(`invalid Safe PIN with ${tries} tries left never changes or retries the PIN`, async () => {
    const state = fixture();
    let attempts = 0;
    state.applet.authenticate = async () => {
      attempts++;
      throw new CBORAppletError({code: 'INVALID_PIN', tries});
    };
    await assert.rejects(state.run(), {
      message: tries
        ? 'Incorrect Safe PIN, tries remaining: 4'
        : 'Safe PIN blocked',
    });
    assert.equal(attempts, 1);
    assert.deepEqual(state.calls, []);
  });
}

test('a blocked or uninitialized Safe does not consume authentication attempts', async () => {
  for (const pin of [0, false]) {
    const state = fixture();
    await assert.rejects(
      state.run('Safe', {...hello, pins: {...hello.pins, safe: pin}}),
    );
    assert.deepEqual(state.calls, []);
  }
});

test('cancellation after authentication prevents the write', async () => {
  const state = fixture();
  state.applet.authenticate = async () => state.controller.abort();
  await assert.rejects(state.run(), {name: 'AbortError'});
  assert.deepEqual(state.calls, []);
});

test('cancellation during a successful write preserves its acknowledged result', async () => {
  const state = fixture();
  state.applet.setPIN = async () => state.controller.abort();
  assert.equal(await state.run(), card.id);
});

test('an unconfirmed write is not replayed and does not expose command details', async () => {
  const state = fixture();
  let writes = 0;
  state.applet.setPIN = async () => {
    writes++;
    throw new Error('sensitive transport payload');
  };
  await assert.rejects(state.run(), error => {
    assert.equal(error.message, 'PIN update not confirmed');
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(writes, 1);
});

test('saving a replacement Access PIN updates an unlocked page cache and keeps other remembered PINs', async () => {
  let reads = 0;
  let saved = {[card.id]: oldPIN, 55667788: 'other-pin'};
  const session = new MonoidPINSession({
    getPINs: async () => {
      reads++;
      return {...saved};
    },
    setPIN: async (id, pin) => {
      saved = {...saved, [id]: pin};
      return saved;
    },
  });
  await session.getPINs();
  session.rememberPIN('55667788', 'manual-pin');
  await session.setPIN(card.id, newPIN);
  assert.deepEqual(await session.getPINs(), {
    [card.id]: newPIN,
    55667788: 'manual-pin',
  });
  assert.equal(reads, 1);
});

test('saving without a prior unlock initializes the page cache from the saved snapshot', async () => {
  const session = new MonoidPINSession({
    getPINs: async () => {
      throw new Error('Should reuse saved snapshot');
    },
    setPIN: async (id, pin) => ({[id]: pin, 55667788: 'other-pin'}),
  });
  await session.setPIN(card.id, newPIN);
  assert.deepEqual(await session.getPINs(), {
    [card.id]: newPIN,
    55667788: 'other-pin',
  });
});
