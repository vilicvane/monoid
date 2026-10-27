import assert from 'node:assert/strict';
import {test} from 'node:test';

import {HeldPINs} from '../.bld/app/@lib/held-pins.js';

import {pinClock} from './helpers/held-pins.mjs';

const MINUTE = 60_000;

test('reads and writes refresh the whole holder, then one timer wipes every PIN', t => {
  const clock = pinClock(t);
  const pins = new HeldPINs();
  pins.set('first', 'First-42');
  clock.tick(4 * MINUTE);
  pins.set('second', 'Second-42');
  clock.tick(4 * MINUTE);
  assert.equal(pins.get('first'), 'First-42');
  clock.tick(4 * MINUTE);
  assert.equal(pins.get('second'), 'Second-42');
  assert.equal(clock.timers.size, 1);
  assert.equal(clock.listeners.size, 1);
  const owner = pins.signal;
  clock.tick(5 * MINUTE);
  assert.equal(owner.aborted, true);
  assert.equal(pins.get('first'), undefined);
  assert.equal(pins.get('second'), undefined);
  assert.equal(clock.timers.size, 0);
  assert.equal(clock.listeners.size, 0);
});

test('a suspended timer cannot extend a PIN lifetime on the next read', t => {
  const clock = pinClock(t);
  const pins = new HeldPINs();
  pins.set('card', 'Secret-42');
  const owner = pins.signal;
  clock.elapse(5 * MINUTE);
  assert.equal(pins.get('card'), undefined);
  pins.set('card', 'late completion', owner);
  assert.equal(pins.get('card'), undefined);
});

test('visible inactivity does not clear; hiding aborts every holder and blocks late refill', t => {
  const clock = pinClock(t);
  const first = new HeldPINs(),
    second = new HeldPINs();
  first.set('one', 'Access-42');
  second.set('two', 'Secret-42');
  const firstOwner = first.signal;
  const secondOwner = second.signal;
  globalThis.document.dispatchEvent(new Event('pause'));
  clock.visibility('visible');
  assert.equal(first.get('one'), 'Access-42');
  assert.equal(firstOwner.aborted, false);
  clock.visibility('hidden');
  assert.equal(firstOwner.aborted, true);
  assert.equal(secondOwner.aborted, true);
  assert.equal(clock.listeners.size, 0);
  first.set('one', 'hidden write');
  assert.equal(first.get('one'), undefined);
  clock.visibility('visible');
  second.set('two', 'late unlock', secondOwner);
  assert.equal(second.get('two'), undefined);
  assert.equal(clock.listeners.size, 0);
});

test('an old owner cannot refill or refresh a new generation; empty holders detach', t => {
  const clock = pinClock(t);
  const pins = new HeldPINs();
  const old = pins.signal;
  assert.equal(clock.listeners.size, 0);
  pins.clear();
  pins.set('card', 'Secret-42');
  clock.tick(4 * MINUTE);
  pins.set('card', 'stale PIN', old);
  clock.tick(MINUTE);
  assert.equal(pins.get('card'), undefined);
  pins.set('card', 'Secret-42');
  pins.delete('card');
  assert.equal(clock.listeners.size, 0);
  assert.equal(clock.timers.size, 0);
});

test('deleting the last PIN detaches without ending the owner or invalidating its writers', t => {
  const clock = pinClock(t);
  const pins = new HeldPINs();
  pins.set('first', 'First-42');
  const owner = pins.signal;
  const writeSecond = () => pins.set('second', 'Second-42', owner);

  pins.delete('first');
  assert.equal(pins.get('first'), undefined);
  assert.equal(clock.listeners.size, 0);
  assert.equal(clock.timers.size, 0);
  assert.equal(owner.aborted, false);
  assert.equal(pins.signal, owner);

  writeSecond();
  assert.equal(pins.get('second'), 'Second-42');
  assert.equal(clock.listeners.size, 1);
  assert.equal(clock.timers.size, 1);
});
