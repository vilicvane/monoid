import assert from 'node:assert/strict';
import {test} from 'node:test';

import {autorun} from 'mobx';
import {routra} from 'routra';

import {SyncCardsState} from '../.bld/app/@components/views/safe/@card/sync-cards-state.js';
import {ROUTE_SCHEMA} from '../.bld/app/@routes.js';
import {SyncCardsStore} from '../.bld/app/@services/sync-cards-store.js';

function hello(number) {
  return {
    version: 1,
    id: Uint8Array.of(0, 0, 0, number),
    publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(number)),
    bundle: false,
    authority: false,
    pins: {access: 5, secret: 5},
  };
}

const source = {
  id: '00000001',
  publicKey: `04${'01'.repeat(64)}`,
  bundle: false,
  items: [{index: '02400000000000000001', type: 'seed', secret: true}],
};

const PIN = 'Secret-42';
const emptyCard = {
  authenticate: async () => {},
  list: async () => ({items: []}),
};
const signal = () => new AbortController().signal;

function getFlow(store, id, card) {
  return store.getOrCreate(id, () => new SyncCardsState(card));
}

test('the Card cache is an identity preview, not a completed sync read', () => {
  const flow = getFlow(new SyncCardsStore(), 'sync', source);
  assert.equal(flow.sourceCard, source);
  assert.equal(flow.sourceConsumed, false);
  assert.equal(flow.session.phase, 'collect');
  assert.equal(flow.session.cards.length, 0);
});

test('returning through Routra retains only the originating sync flow and its read cards', async t => {
  const store = new SyncCardsStore();
  const router = routra(ROUTE_SCHEMA, {});
  await router.safe.$reset().$completed;
  await router.safe
    .syncCards({card: {id: source.id, publicKey: source.publicKey}})
    .$push().$completed;

  const views = router.safe.syncCards.$view();
  t.after(autorun(() => views.$entries.length));
  const first = views.$entries[0];
  const firstKey = first.$key;
  const flow = getFlow(store, first.syncId, source);
  await flow.session.add(emptyCard, hello(1), signal(), {pin: PIN});
  flow.consumeSource();
  flow.markInterrupted(source.publicKey, true);

  await router.sessions.$push().$completed;
  assert.equal(views.$entries.length, 0);
  const back = router.$backTo(router.safe.syncCards.$exact);
  assert.ok(back);
  await back().$completed;

  const returned = views.$entries[0];
  assert.notEqual(returned.$key, firstKey);
  assert.equal(getFlow(store, returned.syncId), flow);
  assert.equal(flow.session.cards.length, 1);
  assert.equal(flow.session.cards[0].publicKey, source.publicKey);
  assert.equal(flow.sourceConsumed, true);
  assert.equal(flow.interruptedCards.has(source.publicKey), true);

  await router.safe.syncCards({card: first.card}).$push().$completed;
  const separate = getFlow(store, views.$entries[0].syncId, source);
  assert.notEqual(separate, flow);
  assert.equal(separate.session.cards.length, 0);
  await router.$back().$completed;
  assert.equal(getFlow(store, views.$entries[0].syncId), flow);
});

test('Start over clears collected data and progress only for the current sync flow', async () => {
  const store = new SyncCardsStore();
  const flow = getFlow(store, 'restart', source);
  const other = getFlow(store, 'other', source);
  await flow.session.add(emptyCard, hello(1), signal(), {pin: PIN});
  await flow.session.add(emptyCard, hello(2), signal(), {pin: PIN});
  await other.session.add(emptyCard, hello(3), signal(), {pin: PIN});
  const otherCards = other.session.cards;
  flow.consumeSource();
  flow.markInterrupted(source.publicKey, true);
  flow.exitSteps();
  flow.restart();

  assert.equal(flow.session.phase, 'collect');
  assert.equal(flow.session.cards.length, 0);
  assert.equal(flow.sourceConsumed, true);
  assert.equal(flow.stepsExited, false);
  assert.equal(flow.interruptedCards.size, 0);
  assert.equal(other.session.cards, otherCards);
  assert.equal(other.session.cards.length, 1);
});
