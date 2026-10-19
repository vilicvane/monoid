import assert from 'node:assert/strict';
import {test} from 'node:test';

import {autorun} from 'mobx';
import {routra} from 'routra';

import {CopyItemsState} from '../.bld/app/@components/views/safe/@card/copy-items-state.js';
import {ROUTE_SCHEMA} from '../.bld/app/@routes.js';
import {CopyItemsStore} from '../.bld/app/@services/copy-items-store.js';

const index = '02400000000000000001';
const secondIndex = '02400000000000000002';

function hello(number) {
  return {
    id: Uint8Array.of(0, 0, 0, number),
    publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(number)),
    bundle: false,
    pins: {access: 5, safe: 5},
  };
}

const source = {
  id: '00000001',
  publicKey: `04${'01'.repeat(64)}`,
  bundle: false,
  items: [index, secondIndex].map(index => ({
    index,
    type: 'seed',
    secret: true,
  })),
};

function getFlow(store, id, sourceCard, sourceIndexes) {
  return store.getOrCreate(
    id,
    () => new CopyItemsState(sourceCard, sourceIndexes),
  );
}

test('Routra returns to the same Copy flow after Setup removes and recreates its view', async t => {
  const store = new CopyItemsStore();
  const router = routra(ROUTE_SCHEMA, {});
  await router.safe.$reset().$completed;
  await router.safe
    .copyItems({
      copyId: 'copy-one',
      sourceCard: source,
      sourceIndexes: [index],
    })
    .$push().$completed;
  const views = router.safe.copyItems.$view();
  t.after(autorun(() => views.$entries.length));
  const first = views.$entries[0];
  const firstKey = first.$key;
  const flow = getFlow(
    store,
    first.copyId,
    first.sourceCard,
    first.sourceIndexes,
  );
  await flow.session.addTarget(hello(2));
  await router.safe
    .setupCard({cardInformation: {}, copyId: first.copyId})
    .$push().$completed;
  assert.equal(views.$entries.length, 0);
  const setupView = router.safe.setupCard.$view().$entries[0];
  await store.get(setupView.copyId).session.addTarget(hello(3));
  const backup = flow.session.backup;
  const history = JSON.parse(JSON.stringify(router.$snapshot));
  const back = router.$backTo(router.safe.copyItems.$exact);
  assert.ok(back);
  assert.equal(router.safe.setupCard.$active, true);
  await back().$completed;

  const returned = views.$entries[0];
  assert.notEqual(returned.$key, firstKey);
  assert.equal(getFlow(store, returned.copyId), flow);
  assert.equal(flow.session.backup, backup);
  assert.deepEqual(
    backup.items.filter(item => item.selected).map(item => item.index),
    [index],
  );
  assert.equal(backup.targets.length, 2);

  // Browser history restores route data, not the previous view object.
  router.$restore(history);
  await router.$backTo(router.safe.copyItems.$exact)().$completed;
  assert.equal(getFlow(store, views.$entries[0].copyId), flow);

  await router.safe.copyItems({copyId: 'copy-two', sourceCard: source}).$push()
    .$completed;
  const separate = getFlow(store, views.$entries[0].copyId, source);
  assert.notEqual(separate, flow);
  assert.equal(separate.session.backup.targets.length, 0);
  await router.$back().$completed;
  assert.equal(getFlow(store, views.$entries[0].copyId), flow);
});

test('retained Copy state keeps acknowledged exports and UI progress without replaying them', async () => {
  const store = new CopyItemsStore();
  const flow = getFlow(store, 'partial', source);
  await flow.session.addTarget(hello(2));
  await flow.session.confirmTargets();
  const requests = [];
  const failure = new Error('Card lost');
  await assert.rejects(
    flow.session.exportItems(
      {
        authenticate: async () => {},
        exportItem: async ({index}) => {
          requests.push(Buffer.from(index).toString('hex'));
          if (requests.length === 2) throw failure;
          return {data: Uint8Array.of(1, 2, 3)};
        },
      },
      hello(1),
      'Copy-42',
      new AbortController().signal,
      () => {},
    ),
    error => error === failure,
  );
  flow.markInterrupted(source.publicKey, true);
  flow.setNotice('Copy interrupted', true);

  const returned = getFlow(store, 'partial');
  assert.equal(returned.session.busy, false);
  assert.equal(returned.failed, true);
  assert.equal(returned.notice, 'Copy interrupted');
  assert.equal(returned.interruptedCards.has(source.publicKey), true);
  assert.equal(
    returned.session.backup.targets[0].items[0].exported.data,
    '010203',
  );
  assert.equal(returned.session.backup.targets[0].items[1].exported, undefined);
  assert.deepEqual(requests, [index, secondIndex]);

  await returned.session.exportItems(
    {
      authenticate: async () => {},
      exportItem: async ({index}) => {
        requests.push(Buffer.from(index).toString('hex'));
        return {data: Uint8Array.of(4)};
      },
    },
    hello(1),
    'Copy-42',
    new AbortController().signal,
    () => {},
  );
  assert.deepEqual(requests, [index, secondIndex, secondIndex]);
});

test('Start over resets only its own flow and preserves the original selection', async () => {
  const store = new CopyItemsStore();
  const flow = getFlow(store, 'restart', source, [secondIndex]);
  const other = getFlow(store, 'other', source);
  await flow.session.addTarget(hello(2));
  await other.session.addTarget(hello(3));
  const otherBackup = other.session.backup;
  flow.markInterrupted(source.publicKey, true);
  flow.startImport(source.publicKey);
  flow.exitSteps();
  flow.setNotice('Interrupted', true);
  await flow.restart();

  assert.equal(flow.session.backup.targets.length, 0);
  assert.deepEqual(
    flow.session.backup.items
      .filter(item => item.selected)
      .map(item => item.index),
    [secondIndex],
  );
  assert.equal(flow.notice, undefined);
  assert.equal(flow.failed, false);
  assert.equal(flow.stepsExited, false);
  assert.equal(flow.interruptedCards.size, 0);
  assert.equal(flow.startedImports.size, 0);
  assert.equal(other.session.backup, otherBackup);
});
