import assert from 'node:assert/strict';
import {test} from 'node:test';

import {AuthorityBundleSession} from '../.bld/app/@components/views/safe/@card/authority-bundle-session.js';
import {CardBundleExtensionSession} from '../.bld/app/@components/views/safe/@card/card-bundle-extension-session.js';
import {CardBundleSession} from '../.bld/app/@components/views/safe/@card/card-bundle-session.js';
import {CardBundleStore} from '../.bld/app/@services/card-bundle-store.js';

const createSession = () => new CardBundleSession();

test('new flows initialize their mode and Authority session together; existing flows ignore initial options', () => {
  const store = new CardBundleStore();
  const session = new AuthorityBundleSession();
  const flow = store.getOrCreate('authority', createSession, {
    bundle: 'authority',
    createAuthority: () => session,
  });
  assert.equal(flow.bundle, 'authority');
  assert.equal(flow.authority, session);
  assert.equal(
    store.getOrCreate('cards', createSession, {bundle: 'card'}).bundle,
    'card',
  );
  const unexpected = () => assert.fail('A retained flow must not be recreated');
  const reused = store.getOrCreate('authority', unexpected, {
    bundle: 'card',
    createAuthority: unexpected,
  });
  assert.equal(reused, flow);
  assert.equal(reused.bundle, 'authority');
  assert.equal(reused.authority, session);
});

function hello(id, overrides = {}) {
  return {
    version: 1,
    id: Uint8Array.of(0, 0, 0, id),
    publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(id)),
    bundle: false,
    authority: false,
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

test('installed extension target returns only to its original flow and cannot replace a confirmed target', async () => {
  const store = new CardBundleStore();
  const source = {
    id: '00000001',
    publicKey: Buffer.from(hello(1).publicKey).toString('hex'),
    bundle: 'ab'.repeat(32),
  };
  const create = () => new CardBundleExtensionSession(source);
  const first = store.getOrCreateExtension('first', create);
  const other = store.getOrCreateExtension('other', create);
  await store.acceptExtensionCard('first', hello(3));
  await store.acceptExtensionCard('first', hello(3));
  assert.equal(store.getOrCreateExtension('first', create), first);
  assert.equal(first.phase, 'collecting');
  assert.equal(store.getExtensionCard('other'), undefined);
  await first.addCard(store.getExtensionCard('first'));
  store.consumeExtensionCard('first');
  assert.equal(store.getExtensionCard('first'), undefined);
  assert.equal(first.phase, 'requesting');
  assert.equal(first.target.id, '00000003');
  assert.equal(other.target, undefined);
  await assert.rejects(store.acceptExtensionCard('missing', hello(4)));
  await store.acceptExtensionCard('first', hello(4));
  await assert.rejects(first.addCard(store.getExtensionCard('first')));
  store.consumeExtensionCard('first');
  await assert.rejects(
    store.acceptExtensionCard(
      'first',
      hello(3, {
        pins: {access: false, secret: false},
      }),
    ),
  );
  await first.configureCard(
    {
      authenticate: async () => {},
      extendBundle: async () => ({data: Uint8Array.of(1)}),
    },
    hello(1, {bundle: new Uint8Array(32).fill(0xab)}),
    '123456',
    new AbortController().signal,
  );
  await assert.rejects(store.acceptExtensionCard('first', hello(3)));
  assert.equal(first.phase, 'approving');
});

test('installation retains a foreign Bundle until the addition flow can confirm reset', async () => {
  const store = new CardBundleStore();
  const session = store.getOrCreateExtension(
    'extension',
    () =>
      new CardBundleExtensionSession({
        id: '00000001',
        publicKey: Buffer.from(hello(1).publicKey).toString('hex'),
        bundle: 'ab'.repeat(32),
      }),
  );
  const installed = hello(3, {bundle: new Uint8Array(32).fill(0xcd)});
  await store.acceptExtensionCard('extension', installed);
  assert.equal(session.phase, 'collecting');
  assert.equal(store.getExtensionCard('extension'), installed);
  session.validateAddition(installed);
  await assert.rejects(session.addCard(installed), /already belongs/);
});
