import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

import {pinClock} from './helpers/held-pins.mjs';

let platform;
const registrations = [];

mock.module('@capacitor/core', {
  namedExports: {Capacitor: {getPlatform: () => platform}},
});
mock.module('@capacitor/app', {
  namedExports: {
    App: {
      addListener: async (event, callback) => {
        const ready = Promise.withResolvers();
        registrations.push({event, callback, ready});
        await ready.promise;
        return {remove: async () => {}};
      },
    },
  },
});

for (const current of ['android', 'ios', 'web']) {
  test(`${current}: shared hidden state clears holders and accepts new PINs after resume`, async t => {
    platform = current;
    registrations.length = 0;
    const hidden = await import(`../.bld/app/@lib/app-hidden.js?${current}`);
    t.mock.module('../.bld/app/@lib/app-hidden.js', {namedExports: hidden});
    const {HeldPINValue, HeldPINs} = await import(
      `../.bld/app/@lib/held-pins.js?${current}`
    );
    const clock = pinClock(t);
    const released = mock.fn();
    const access = new HeldPINValue(released);
    const secret = new HeldPINs();

    assert.equal(registrations.length, current === 'android' ? 1 : 0);
    const registration = registrations[0];
    if (registration) assert.equal(registration.event, 'appStateChange');
    const appState = isActive => registration?.callback({isActive});

    // Holders can subscribe before the asynchronous native listener handle resolves.
    for (const resume of ['active', 'visible']) {
      access.set('Access-42');
      secret.set('card', 'Secret-42');
      const accessOwner = access.signal;
      const secretOwner = secret.signal;
      assert.equal(clock.listeners.size, 1);
      appState(false);
      assert.equal(globalThis.document.visibilityState, 'visible');
      assert.equal(accessOwner.aborted, current === 'android');
      assert.equal(secretOwner.aborted, current === 'android');
      assert.equal(
        access.get(),
        current === 'android' ? undefined : 'Access-42',
      );
      assert.equal(
        secret.get('card'),
        current === 'android' ? undefined : 'Secret-42',
      );

      if (current === 'android') {
        assert.equal(clock.timers.size, 0);
        const empty = new HeldPINs();
        empty.set('card', 'Hidden-42');
        assert.equal(empty.get('card'), undefined);
      }
      if (resume === 'active') appState(true);
      else clock.visibility('visible');
      if (current === 'android') {
        access.set('late unlock', accessOwner);
        secret.set('card', 'late authentication', secretOwner);
        assert.equal(access.get(), undefined);
        assert.equal(secret.get('card'), undefined);
      }
      access.set('NewAccess-42');
      secret.set('card', 'NewSecret-42');
      assert.equal(access.get(), 'NewAccess-42');
      assert.equal(secret.get('card'), 'NewSecret-42');
    }
    registration?.ready.resolve();
    assert.equal(registrations.length, current === 'android' ? 1 : 0);

    const accessOwner = access.signal;
    const secretOwner = secret.signal;
    clock.visibility('hidden');
    appState(true);
    assert.equal(accessOwner.aborted, true);
    assert.equal(secretOwner.aborted, true);
    assert.equal(clock.listeners.size, 0);
    assert.equal(clock.timers.size, 0);
    assert(released.mock.callCount() > 0);
    access.set('Hidden-42');
    assert.equal(access.get(), undefined);
    clock.visibility('visible');
    access.set('Resumed-42');
    secret.set('card', 'Resumed-43');
    assert.equal(access.get(), 'Resumed-42');
    assert.equal(secret.get('card'), 'Resumed-43');
  });
}
