import assert from 'node:assert/strict';
import {test} from 'node:test';

import {CardResetSession} from '../.bld/app/@components/views/safe/@card/card-reset-session.js';
import {AppletISOError} from '../.bld/app/@lib/applet.js';
import {MonoidWrongCardError} from '../.bld/app/@lib/monoid/card-error.js';

const hex = bytes => Buffer.from(bytes).toString('hex');

function fixture() {
  const hello = {
    version: 1,
    id: Uint8Array.of(1, 2, 3, 4),
    publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(5)),
    bundle: new Uint8Array(32).fill(6),
    authority: false,
    alias: false,
    allowPeerExtension: false,
    pins: {access: 5, secret: 5},
  };
  const resetHello = {
    ...hello,
    id: Uint8Array.of(8, 7, 6, 5),
    publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(9)),
    bundle: false,
    authority: false,
    alias: false,
    allowPeerExtension: false,
    pins: {access: false, secret: false},
  };
  const session = new CardResetSession({
    id: hex(hello.id),
    publicKey: hex(hello.publicKey),
    bundle: hex(hello.bundle),
  });
  const state = {
    hello,
    resetHello,
    session,
    controller: new AbortController(),
    calls: [],
    applet: {
      async reset(request) {
        state.calls.push(['reset', structuredClone(request)]);
        await state.onResetCommand?.();
        return {};
      },
      async hello(request) {
        state.calls.push(['hello', structuredClone(request)]);
        await state.onHello?.();
        return state.resetHello;
      },
    },
    async beforeReset() {
      state.calls.push(['beforeReset']);
      await state.onBeforeReset?.();
    },
    onReset() {
      state.calls.push(['onReset']);
    },
    run(current = hello) {
      return session.readOrReset(
        state.applet,
        current,
        state.beforeReset,
        state.onReset,
        state.controller.signal,
      );
    },
  };
  return state;
}

test('full reset runs only after identity validation and pre-reset cleanup, then confirms the fresh Hello', async () => {
  const state = fixture();
  assert.deepEqual(await state.run(), state.resetHello);
  assert.deepEqual(state.calls, [
    ['beforeReset'],
    ['reset', {}],
    ['onReset'],
    ['hello', {}],
  ]);
  assert.equal(state.session.attempted, true);
  assert.equal(state.session.confirmed, true);
});

for (const changed of ['id', 'publicKey', 'bundle']) {
  test(`a different full ${changed} is rejected before local cleanup or Reset`, async () => {
    const state = fixture();
    const value = state.hello[changed].slice();
    value[value.length - 1] ^= 1;
    await assert.rejects(
      state.run({...state.hello, [changed]: value}),
      changed === 'bundle' ? /Card bundle changed/ : MonoidWrongCardError,
    );
    assert.deepEqual(state.calls, []);
    assert.equal(state.session.attempted, false);
    assert.equal(state.session.confirmed, false);
  });
}

test('an already aborted operation performs no local cleanup or card commands', async () => {
  const state = fixture();
  state.controller.abort();
  await assert.rejects(state.run(), {name: 'AbortError'});
  assert.deepEqual(state.calls, []);
  assert.equal(state.session.attempted, false);
});

test('failed local credential cleanup prevents Reset and leaves the approved attempt unused', async () => {
  const state = fixture();
  state.onBeforeReset = () => {
    throw new Error('Vault unavailable');
  };
  await assert.rejects(state.run(), /Vault unavailable/);
  assert.deepEqual(state.calls, [['beforeReset']]);
  assert.equal(state.session.attempted, false);
  state.onBeforeReset = undefined;
  await state.run();
  assert.equal(state.calls.filter(call => call[0] === 'reset').length, 1);
});

test('cancellation during pre-reset cleanup prevents the destructive command', async () => {
  const state = fixture();
  state.onBeforeReset = () => state.controller.abort();
  await assert.rejects(state.run(), {name: 'AbortError'});
  assert.deepEqual(state.calls, [['beforeReset']]);
  assert.equal(state.session.attempted, false);
  assert.equal(state.session.confirmed, false);
});

for (const [label, error] of [
  [
    'an unsupported Reset INS',
    new AppletISOError(
      'Failed to request more data.',
      0x6d00,
      new Uint8Array(),
    ),
  ],
  ['an unknown Reset error', new Error('Unexpected reset failure')],
]) {
  test(`${label} propagates unchanged without replaying the attempted Reset`, async () => {
    const state = fixture();
    state.onResetCommand = () => {
      throw error;
    };

    await assert.rejects(state.run(), actual => actual === error);
    assert.equal(state.session.attempted, true);
    assert.equal(state.session.confirmed, false);
    await assert.rejects(state.run(), /Card reset not confirmed/);
    assert.deepEqual(state.calls, [['beforeReset'], ['reset', {}]]);
  });
}

test('a lost Reset response is never replayed while the card still reports its old Bundle', async () => {
  const state = fixture();
  state.onResetCommand = () => {
    throw new Error('NFC response lost');
  };
  await assert.rejects(state.run(), /NFC response lost/);
  assert.equal(state.session.attempted, true);
  assert.equal(state.session.confirmed, false);
  await assert.rejects(state.run(), /Card reset not confirmed/);
  await assert.rejects(state.run(), /Card reset not confirmed/);
  assert.deepEqual(state.calls, [['beforeReset'], ['reset', {}]]);
});

test('a lost Reset response cannot bind any later unbundled identity to the original card', async () => {
  const state = fixture();
  state.onResetCommand = () => {
    throw new Error('NFC response lost');
  };
  await assert.rejects(state.run(), /NFC response lost/);
  await assert.rejects(state.run(state.resetHello), /Card reset not confirmed/);
  assert.equal(state.session.replacement, undefined);
  assert.deepEqual(state.calls, [['beforeReset'], ['reset', {}]]);
});

test('an observed replacement is accepted on retry but another new identity is rejected without Reset', async () => {
  const state = fixture();
  await state.run();
  const initialized = {...state.resetHello, pins: {access: 5, secret: 5}};
  assert.deepEqual(await state.run(initialized), initialized);
  const swapped = {...initialized, publicKey: state.hello.publicKey};
  await assert.rejects(state.run(swapped), MonoidWrongCardError);
  assert.equal(state.calls.filter(call => call[0] === 'reset').length, 1);
});

test('an unbundled card discovered before any Reset attempt is rejected without cleanup or confirmation', async () => {
  const state = fixture();
  const unbundled = {...state.hello, bundle: false};
  const reinitialized = {...unbundled, pins: {access: 5, secret: 5}};
  for (const hello of [unbundled, reinitialized]) {
    await assert.rejects(
      state.run(hello),
      new RegExp(
        `Card bundle changed, scan card ${state.session.card.id} again`,
      ),
    );
    assert.deepEqual(state.calls, []);
    assert.equal(state.session.attempted, false);
    assert.equal(state.session.confirmed, false);
  }
});

test('Reset ACK publishes cache invalidation even when cancellation arrives during the APDU', async () => {
  const state = fixture();
  state.onResetCommand = () => state.controller.abort();
  await assert.rejects(state.run(), {name: 'AbortError'});
  assert.deepEqual(state.calls, [['beforeReset'], ['reset', {}], ['onReset']]);
  assert.equal(state.session.attempted, true);
  assert.equal(state.session.confirmed, true);
});

for (const [label, override] of [
  ['existing Bundle', {bundle: new Uint8Array(32).fill(6)}],
  ['Secret PIN still set', {pins: {access: false, secret: 5}}],
  ['Access PIN still set', {pins: {access: 5, secret: false}}],
  ['blocked PINs', {pins: {access: 0, secret: 0}}],
]) {
  test(`Reset ACK followed by ${label} fails final verification without replaying deletion`, async () => {
    const state = fixture();
    state.resetHello = {...state.resetHello, ...override};
    await assert.rejects(state.run(), /Card reset state not confirmed/);
    assert.equal(state.session.attempted, true);
    assert.equal(state.session.confirmed, true);
    assert.deepEqual(state.calls, [
      ['beforeReset'],
      ['reset', {}],
      ['onReset'],
      ['hello', {}],
    ]);
    await assert.rejects(state.run(), /Card reset not confirmed/);
    assert.equal(state.calls.filter(call => call[0] === 'reset').length, 1);
  });
}

for (const changed of ['id', 'publicKey']) {
  test(`post-reset Hello validates the full ${changed}`, async () => {
    const state = fixture();
    const value = state.hello[changed].slice();
    state.resetHello = {...state.resetHello, [changed]: value};
    await assert.rejects(state.run(), /Card reset state not confirmed/);
    assert.equal(state.session.confirmed, true);
    assert.deepEqual(state.calls, [
      ['beforeReset'],
      ['reset', {}],
      ['onReset'],
      ['hello', {}],
    ]);
  });
}

test('a malformed post-reset Hello cannot masquerade as initialized-reset state', async () => {
  const state = fixture();
  state.resetHello = {id: state.hello.id, bundle: false};
  await assert.rejects(state.run());
  assert.equal(state.session.confirmed, true);
  assert.equal(state.calls.filter(call => call[0] === 'reset').length, 1);
});

test('failed post-reset Hello retains the ACK and does not reset again on recovery', async () => {
  const state = fixture();
  state.onHello = () => {
    throw new Error('Card removed');
  };
  await assert.rejects(state.run(), /Card removed/);
  assert.equal(state.session.confirmed, true);
  state.onHello = undefined;
  await assert.rejects(state.run(state.resetHello), /Card reset not confirmed/);
  assert.equal(state.calls.filter(call => call[0] === 'reset').length, 1);
  assert.equal(state.calls.filter(call => call[0] === 'onReset').length, 1);
});
