import assert from 'node:assert/strict';
import {test} from 'node:test';

import {CardBundleSession} from '../.bld/app/@components/views/safe/@card/card-bundle-session.js';
import {CardBundleStore} from '../.bld/app/@services/card-bundle-store.js';

const createSession = () => new CardBundleSession();

function hello(id, overrides = {}) {
  return {
    version: 1,
    id: Uint8Array.of(0, 0, 0, id),
    publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(id)),
    bundle: false,
    pins: {access: 5, secret: 5},
    ...overrides,
  };
}

test('a maintenance result returns to only its originating Bundle and is idempotent', async () => {
  const store = new CardBundleStore();
  const first = store.getOrCreate('first', createSession);
  const other = store.getOrCreate('other', createSession);
  first.sourceConsumed = true;
  await store.acceptInstalledCard('first', hello(1));
  await store.acceptInstalledCard('first', hello(1));
  assert.equal(store.getOrCreate('first', createSession), first);
  assert.equal(first.sourceConsumed, true);
  assert.equal(first.session.cards.length, 1);
  assert.equal(other.session.cards.length, 0);
  assert.equal(store.get('missing'), undefined);
});

test('maintenance cannot append to an absent or sealed member list', async () => {
  const store = new CardBundleStore();
  await assert.rejects(store.acceptInstalledCard('missing', hello(1)));
  const flow = store.getOrCreate('first', createSession);
  await store.acceptInstalledCard('first', hello(1));
  await store.acceptInstalledCard('first', hello(2));
  await flow.session.beginRoundTwo();
  await assert.rejects(
    store.acceptInstalledCard('first', hello(3)),
    /no longer accepting/,
  );
  assert.equal(flow.session.cards.length, 2);
});

for (const overrides of [
  {bundle: new Uint8Array(32).fill(1)},
  {pins: {access: false, secret: false}},
  {pins: {access: 5, secret: false}},
  {pins: {access: 0, secret: 5}},
  {pins: {access: 5, secret: 0}},
]) {
  test(`maintenance rejects an unprepared card: ${JSON.stringify(overrides.pins ?? 'bundle')}`, async () => {
    const store = new CardBundleStore();
    const flow = store.getOrCreate('first', createSession);
    await assert.rejects(
      store.acceptInstalledCard('first', hello(1, overrides)),
    );
    assert.equal(flow.session.cards.length, 0);
  });
}

test('same public key with a changed ID is not treated as a duplicate completion', async () => {
  const store = new CardBundleStore();
  const flow = store.getOrCreate('first', createSession);
  await store.acceptInstalledCard('first', hello(1));
  await assert.rejects(
    store.acceptInstalledCard('first', hello(1, {id: hello(2).id})),
    /identity changed/,
  );
  assert.equal(flow.session.cards[0].id, '00000001');
});
