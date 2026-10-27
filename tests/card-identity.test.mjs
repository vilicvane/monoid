import assert from 'node:assert/strict';
import {test} from 'node:test';

import {MonoidWrongCardError} from '../.bld/app/@lib/monoid/card-error.js';
import {
  assertSameCard,
  assertSameCardWithBundle,
  readBackupCardIdentity,
  readCardIdentity,
} from '../.bld/app/@lib/monoid/card-identity.js';
import {cardName, cardNameWithId} from '../.bld/app/@lib/monoid/card-name.js';

const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
const identity = {
  id: '01234567',
  publicKey: `04${'12'.repeat(64)}`,
  bundle: '34'.repeat(32),
  alias: '旅行卡',
  authority: 'https://authority.monoid.app/',
  allowPeerExtension: true,
};
const hello = {
  id: bytes(identity.id),
  publicKey: bytes(identity.publicKey),
  bundle: bytes(identity.bundle),
  alias: identity.alias,
  authority: identity.authority,
  allowPeerExtension: identity.allowPeerExtension,
};

test('card names prefer aliases while scan names retain the ID for both Hello and cached cards', () => {
  for (const id of [identity.id, hello.id]) {
    for (const alias of [undefined, false, '', 'Daily wallet']) {
      assert.equal(cardName({id, alias}), alias || identity.id);
      assert.equal(
        cardNameWithId({id, alias}),
        alias ? `Daily wallet (${identity.id})` : identity.id,
      );
    }
  }
});

test('reads the existing atomic identity and matches both Hello and retained identities', () => {
  assert.deepEqual(readCardIdentity(hello), {
    id: identity.id,
    publicKey: identity.publicKey,
  });
  assert.deepEqual(readBackupCardIdentity(hello), identity);
  assertSameCard(hello, identity);
  assertSameCard(identity, identity);
  assertSameCardWithBundle(hello, identity);
  assertSameCardWithBundle(identity, identity);
});

for (const [field, value] of [
  ['id', bytes('89abcdef')],
  ['publicKey', bytes(`04${'56'.repeat(64)}`)],
]) {
  test(`rejects a changed ${field} with the expected Card ID`, () => {
    for (const check of [assertSameCard, assertSameCardWithBundle]) {
      assert.throws(
        () => check({...hello, [field]: value}, identity),
        error => {
          assert.ok(error instanceof MonoidWrongCardError);
          assert.equal(error.card.id, identity.id);
          assert.equal(
            error.message,
            `Wrong card, scan ${identity.alias} (${identity.id})`,
          );
          return true;
        },
      );
    }
  });
}

for (const bundle of [false, bytes('78'.repeat(32))]) {
  test(`only bundle-dependent operations reject ${bundle === false ? 'removed' : 'changed'} membership`, () => {
    const current = {...hello, bundle};
    assertSameCard(current, identity);
    assert.throws(
      () => assertSameCardWithBundle(current, identity),
      MonoidWrongCardError,
    );
    assert.throws(
      () =>
        assertSameCardWithBundle(
          current,
          identity,
          'Card bundle changed, start over',
        ),
      {message: 'Card bundle changed, start over'},
    );
  });
}

test('an unbundled identity matches only an unbundled card for bundle operations', () => {
  const expected = {...identity, bundle: false};
  assertSameCardWithBundle({...hello, bundle: false}, expected);
  assertSameCard(hello, expected);
  assert.throws(
    () => assertSameCardWithBundle(hello, expected),
    MonoidWrongCardError,
  );
});
