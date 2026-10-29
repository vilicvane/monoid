import assert from 'node:assert/strict';
import {test} from 'node:test';

import {MonoidPIN} from '../.bld/app/@atomics.js';

test('Monoid PIN validation accepts 6 to 32 printable ASCII characters', () => {
  for (const length of [6, 16, 17, 32]) {
    assert.equal(MonoidPIN.is('x'.repeat(length)), true);
  }
  assert.equal(MonoidPIN.is(' ~!09AZaz'), true);
});

test('Monoid PIN validation rejects fewer than 6 or more than 32 characters', () => {
  for (const length of [0, 5, 33]) {
    assert.equal(MonoidPIN.is('x'.repeat(length)), false);
  }
});

test('Monoid PIN validation rejects nonprintable and non-ASCII characters', () => {
  for (const pin of ['12345\t', '123456\n', '12345\x7f', '秘密123456']) {
    assert.equal(MonoidPIN.is(pin), false);
  }
});
