import assert from 'node:assert/strict';
import {test} from 'node:test';

import {autorun, runInAction} from 'mobx';
import {routra} from 'routra';

import {SyncCardsState} from '../.bld/app/@components/views/safe/@card/sync-cards-state.js';
import {ROUTE_SCHEMA} from '../.bld/app/@routes.js';
import {CardMaintenanceService} from '../.bld/app/@services/card-maintenance-service.js';
import {SyncCardsStore} from '../.bld/app/@services/sync-cards-store.js';

function cardSnapshot(number) {
  return {
    information: {cplc: {icSerialNumber: String(number)}},
    installation: {
      identity: {installed: true, loaded: true},
      library: {installed: true, loaded: true},
      monoid: {installed: true, loaded: true, version: 1},
      optional: {'security-key': {installed: true, loaded: true}},
      hello: {
        version: 1,
        id: Uint8Array.of(0, 0, 0, number),
        publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(number)),
        bundle: new Uint8Array(32).fill(1),
        authority: false,
        pins: {access: 5, secret: 5},
      },
    },
  };
}

function operationFor(snapshot) {
  const {hello} = snapshot.installation;
  return {
    id: 'maintenance',
    phase: 'ready',
    mode: 'reinstall',
    card: {
      id: Buffer.from(hello.id).toString('hex'),
      publicKey: Buffer.from(hello.publicKey).toString('hex'),
      bundle: Buffer.from(hello.bundle).toString('hex'),
      appletAid: 'f06d6f6e6f69640201',
      fingerprint: 'test-card',
    },
  };
}

test('Card Applets recovers its scanned snapshot after real Routra Sync navigation remounts the view', async t => {
  const store = new SyncCardsStore();
  const router = routra(ROUTE_SCHEMA, {});
  await router.features.$reset().$completed;
  await router.cardApplets().$push().$completed;
  const views = router.cardApplets.$view();
  t.after(autorun(() => views.$entries.length));
  const original = views.$entries[0];
  const originalKey = original.$key;
  assert.equal(original.cardInformation, undefined);
  assert.equal(original.maintenanceSyncId, undefined);

  const snapshot = cardSnapshot(1);
  const operation = operationFor(snapshot);
  const syncId = 'maintenance-sync';
  const flow = store.getOrCreate(
    syncId,
    () => new SyncCardsState(undefined, operation, snapshot),
  );
  // Routra rejects assigning fields absent from the initialized route state.
  runInAction(() => {
    original.maintenanceSyncId = syncId;
  });
  await router.safe.syncCards({syncId}).$push().$completed;
  assert.equal(views.$entries.length, 0, 'the parent is actually unmounted');
  flow.finishMaintenance();
  const preview = router.$back.$switch({progress: 0.3});
  assert.equal(
    views.$entries.length,
    1,
    'a back gesture temporarily mounts the parent',
  );
  assert.equal(router.cardApplets.$exact.$active, false);
  assert.equal(
    store.get(views.$entries[0].maintenanceSyncId)?.maintenanceCardSnapshot,
    snapshot,
  );
  preview.$abort();
  assert.equal(views.$entries.length, 0);
  assert.equal(
    store.get(syncId),
    flow,
    'an aborted gesture must leave the handoff available',
  );
  const back = router.$backTo(router.cardApplets.$exact);
  assert.ok(back);
  await back().$completed;

  const returned = views.$entries[0];
  assert.notEqual(returned.$key, originalKey);
  assert.equal(returned.maintenanceSyncId, syncId);
  const retained = store.get(returned.maintenanceSyncId);
  assert.equal(retained, flow);
  assert.equal(retained.maintenanceSaved, true);
  assert.equal(retained.maintenanceCardSnapshot, snapshot);
  assert.ok(
    retained.maintenanceCardSnapshot.installation.hello.publicKey instanceof
      Uint8Array,
  );
  assert.equal(
    retained.maintenanceCardSnapshot.installation.optional['security-key']
      .installed,
    true,
  );

  const match = CardMaintenanceService.prototype.matchOperation.bind({
    operations: [operation],
  });
  assert.equal(
    match({hello: undefined, cardInformation: returned.cardInformation}),
    undefined,
    'route history alone cannot identify the saved recovery',
  );
  assert.equal(
    match({
      hello: snapshot.installation.hello,
      cardInformation: snapshot.information,
    }),
    operation,
    'the retained Hello identifies the pending reinstall after remount',
  );
});

for (const entry of [undefined, {}]) {
  test(`a fresh Card Applets entry with ${entry ? 'empty' : 'omitted'} state never inherits an earlier maintenance snapshot`, async t => {
    const store = new SyncCardsStore();
    const router = routra(ROUTE_SCHEMA, {});
    await router.features.$reset().$completed;
    await router.cardApplets(entry).$push().$completed;
    const views = router.cardApplets.$view();
    t.after(autorun(() => views.$entries.length));
    const snapshot = cardSnapshot(1);
    const old = store.getOrCreate(
      'old-maintenance',
      () => new SyncCardsState(undefined, operationFor(snapshot), snapshot),
    );
    runInAction(() => {
      views.$entries[0].maintenanceSyncId = 'old-maintenance';
    });
    await router.$backTo(router.features.$exact)().$completed;
    assert.equal(views.$entries.length, 0);
    await router.cardApplets(entry).$push().$completed;
    const fresh = views.$entries[0];
    assert.equal(fresh.maintenanceSyncId, undefined);
    assert.equal(fresh.cardInformation, undefined);
    const freshSnapshot = fresh.maintenanceSyncId
      ? store.get(fresh.maintenanceSyncId)?.maintenanceCardSnapshot
      : undefined;
    assert.equal(freshSnapshot, undefined);
    assert.equal(
      old.maintenanceCardSnapshot,
      snapshot,
      'discarding UI ownership must not mutate another flow',
    );
  });
}

test('separate maintenance flows retain only their own card snapshots across route history restoration', async t => {
  const store = new SyncCardsStore();
  const router = routra(ROUTE_SCHEMA, {});
  const first = cardSnapshot(1);
  const second = cardSnapshot(2);
  const firstFlow = store.getOrCreate(
    'first',
    () => new SyncCardsState(undefined, operationFor(first), first),
  );
  store.getOrCreate(
    'second',
    () => new SyncCardsState(undefined, operationFor(second), second),
  );
  await router.features.$reset().$completed;
  await router
    .cardApplets({maintenanceSyncId: 'first', returnTo: 'safe'})
    .$push().$completed;
  const views = router.cardApplets.$view();
  t.after(autorun(() => views.$entries.length));
  await router.safe.syncCards({syncId: 'first'}).$push().$completed;
  const history = JSON.parse(JSON.stringify(router.$snapshot));
  await router.features.$reset().$completed;
  router.$restore(history);
  await router.$backTo(router.cardApplets.$exact)().$completed;
  const returned = views.$entries[0];
  assert.equal(returned.returnTo, 'safe');
  const retained = store.get(returned.maintenanceSyncId);
  assert.equal(retained, firstFlow);
  assert.equal(retained.maintenanceCardSnapshot, first);
  assert.notEqual(retained.maintenanceCardSnapshot, second);
});
