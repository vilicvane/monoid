import assert from 'node:assert/strict';
import {test} from 'node:test';

import {MonoidCardError} from '../.bld/app/@lib/monoid/card-error.js';
import {
  assertCardPINNotBlocked,
  assertCardPINs,
  assertCardPINsNotBlocked,
} from '../.bld/app/@lib/monoid/card-pins.js';

const hello = (access, secret) => ({pins: {access, secret}});

test('ready PINs pass Access-only and Secret operations', () => {
  assertCardPINs(hello(5, 5));
  assertCardPINs(hello(5, 5), {secret: true});
  assertCardPINsNotBlocked(hello(5, 5));
});

for (const pins of [
  [false, 5],
  [5, false],
  [false, false],
  [false, 0],
  [0, false],
]) {
  test(`ordinary operations require initialized PINs before blocked checks: ${pins}`, () => {
    for (const secret of [false, true]) {
      assert.throws(
        () => assertCardPINs(hello(...pins), {secret}),
        error =>
          error instanceof MonoidCardError &&
          error.message === 'Set up card PINs first',
      );
    }
  });
}

test('Access-only operations allow a blocked Secret PIN', () => {
  assertCardPINs(hello(5, 0));
  assert.throws(() => assertCardPINs(hello(5, 0), {secret: true}), {
    message: 'Secret PIN blocked',
  });
});

test('ordinary operations report blocked Access before blocked Secret', () => {
  for (const secret of [false, true]) {
    assert.throws(() => assertCardPINs(hello(0, 0), {secret}), {
      message: 'Access PIN blocked',
    });
  }
});

test('setup permits unset PINs and keeps Secret-first blocked precedence', () => {
  assertCardPINsNotBlocked(hello(false, false));
  assertCardPINsNotBlocked(hello(false, 5));
  assert.throws(() => assertCardPINsNotBlocked(hello(0, 0)), {
    message: 'Secret PIN blocked',
  });
  assert.throws(() => assertCardPINsNotBlocked(hello(false, 0)), {
    message: 'Secret PIN blocked',
  });
  assert.throws(() => assertCardPINsNotBlocked(hello(0, false)), {
    message: 'Access PIN blocked',
  });
});

test('a Secret PIN update can repair a blocked Access PIN', () => {
  assertCardPINNotBlocked(hello(0, 5), 'secret');
  assert.throws(() => assertCardPINNotBlocked(hello(5, 0), 'secret'), {
    message: 'Secret PIN blocked',
  });
});
