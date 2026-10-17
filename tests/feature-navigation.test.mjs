import assert from 'node:assert/strict';
import {test} from 'node:test';

import {routra} from 'routra';

// eslint-disable-next-line @mufan/scoped-modules -- Exercise the app's routes without initializing platform services.
import {ROUTE_SCHEMA} from '../.bld/app/@routes.js';

async function createRouter() {
  const router = routra(ROUTE_SCHEMA, {});
  await router.features.$reset().$completed;
  return router;
}

function matchingRoots(router, activity) {
  return Object.keys(ROUTE_SCHEMA).filter(name => router[name][activity]);
}

for (const feature of ['sessions', 'transactions']) {
  test(`opening ${feature} from the hub preserves a return to the hub`, async () => {
    const router = await createRouter();
    assert.equal(router.$ableToBack, false);

    const opening = router[feature].$push();
    assert.equal(router.features.$active, true);
    assert.equal(router[feature].$active, false);
    assert.equal(router[feature].$matched, true);
    assert.deepEqual(matchingRoots(router, '$transition'), [feature]);
    await opening.$completed;

    assert.equal(router[feature].$exact.$active, true);
    assert.equal(router.features.$matched, false);
    assert.equal(router.$ableToBack, true);
    assert.equal(router.$snapshot.operation, 'push');

    const closing = router.$back();
    assert.deepEqual(matchingRoots(router, '$transition'), ['features']);
    assert.equal(router[feature].$active, true);
    await closing.$completed;
    assert.equal(router.features.$exact.$active, true);
    assert.equal(router[feature].$matched, false);
    assert.equal(router.$ableToBack, false);
    assert.equal(router.$snapshot.operation, -1);
  });

  test(`${feature} stays active during a cancelled swipe and leaves after a completed swipe`, async () => {
    const router = await createRouter();
    await router[feature].$push().$completed;

    const cancelled = router.$back.$switch({progress: 0.4});
    assert.equal(router[feature].$active, true);
    assert.equal(router[feature].$matched, true);
    assert.equal(router.features.$active, false);
    assert.equal(router.features.$switching, true);
    assert.equal(router.features.$matched, true);
    assert.deepEqual(matchingRoots(router, '$switching'), ['features']);
    assert.deepEqual(matchingRoots(router, '$transition'), []);
    cancelled.$abort();

    assert.equal(router[feature].$active, true);
    assert.equal(router.features.$matched, false);
    assert.equal(router.$ableToBack, true);
    assert.deepEqual(matchingRoots(router, '$switching'), []);
    assert.deepEqual(matchingRoots(router, '$active'), [feature]);

    const completed = router.$back.$switch({progress: 0.6});
    completed({progress: 1, settling: true});
    assert.equal(router[feature].$active, true);
    completed.$complete();

    assert.equal(router.features.$exact.$active, true);
    assert.equal(router.features.$switching, false);
    assert.equal(router[feature].$matched, false);
    assert.equal(router.$ableToBack, false);
    assert.equal(router.$ableToForward, true);

    await router.$forward().$completed;
    assert.equal(router[feature].$exact.$active, true);
  });
}

test('only the outgoing feature is active until both page transitions finish', async context => {
  const router = await createRouter();
  await router.sessions.$push().$completed;
  const sessionsView = router.sessions.$exact.$view();
  const [leaving] = sessionsView.$entries;
  const leavingTransition = leaving.$transition;
  leavingTransition({leaving: true});
  context.after(() => leavingTransition({leaving: false}));

  const opening = router.transactions.$push();
  const [entering] = router.transactions.$exact.$view().$entries;
  const enteringTransition = entering.$transition;
  enteringTransition({entering: true});
  context.after(() => enteringTransition({entering: false}));

  assert.equal(leaving.$leaving.$operation, 'push');
  assert.equal(entering.$entering.$operation, 'push');
  assert.equal(router.sessions.$active, true);
  assert.equal(router.transactions.$active, false);
  assert.equal(router.sessions.$matched, true);
  assert.equal(router.transactions.$matched, true);
  assert.deepEqual(matchingRoots(router, '$transition'), ['transactions']);

  entering.$entering.$complete();
  await Promise.resolve();
  assert.equal(router.sessions.$active, true);
  assert.equal(router.transactions.$active, false);

  leaving.$leaving.$complete();
  await opening.$completed;
  assert.equal(router.sessions.$matched, false);
  assert.equal(router.transactions.$exact.$active, true);
  assert.deepEqual(matchingRoots(router, '$transition'), []);
  assert.deepEqual(sessionsView.$entries, []);
});

test('a navigation reset exposes its new destination while an interrupted swipe still targets a feature', async () => {
  const router = await createRouter();
  await router.sessions.$push().$completed;
  await router.transactions.$push().$completed;

  const swipe = router.$back.$switch({progress: 0.4});
  assert.deepEqual(matchingRoots(router, '$switching'), ['sessions']);
  assert.deepEqual(matchingRoots(router, '$active'), ['transactions']);

  const resetting = router.safe.$reset();
  assert.deepEqual(matchingRoots(router, '$transition'), ['safe']);
  assert.deepEqual(matchingRoots(router, '$switching'), ['sessions']);

  swipe.$abort();
  assert.deepEqual(matchingRoots(router, '$transition'), ['safe']);
  assert.deepEqual(matchingRoots(router, '$switching'), []);
  await resetting.$completed;
  assert.deepEqual(matchingRoots(router, '$active'), ['safe']);
});

test('transaction history preserves wallet and detail state through back and forward without matching Sessions', async () => {
  const router = await createRouter();
  const address = '0x3535353535353535353535353535353535353535';
  const detail = {chainId: 'eip155:1', hash: `0x${'1'.repeat(64)}`};

  await router.transactions.$push().$completed;
  await router.transactions.wallet({address}).$push().$completed;
  await router.transactions.wallet.transaction(detail).$push().$completed;

  assert.equal(router.sessions.$matched, false);
  assert.equal(router.transactions.$active, true);
  assert.equal(router.transactions.wallet.transaction.$exact.$active, true);
  assert.deepEqual({...router.$state}, {address, ...detail});

  await router.$back().$completed;
  assert.equal(router.transactions.wallet.$exact.$active, true);
  assert.deepEqual({...router.$state}, {address});
  assert.equal(router.sessions.$matched, false);

  await router.$back().$completed;
  assert.equal(router.transactions.$exact.$active, true);
  await router.$back().$completed;
  assert.equal(router.features.$exact.$active, true);

  await router.$forward().$completed;
  await router.$forward().$completed;
  await router.$forward().$completed;
  assert.equal(router.transactions.wallet.transaction.$exact.$active, true);
  assert.deepEqual({...router.$state}, {address, ...detail});
  assert.equal(router.sessions.$matched, false);
});

for (const destination of ['features', 'scan', 'safe']) {
  test(`resetting to ${destination} clears the temporary feature and its history`, async () => {
    const router = await createRouter();
    await router.transactions.$push().$completed;
    await router.transactions
      .wallet({address: '0x3535353535353535353535353535353535353535'})
      .$push().$completed;

    const resetting = router[destination].$reset();
    assert.deepEqual(matchingRoots(router, '$transition'), [destination]);
    assert.equal(router.transactions.$active, true);
    await resetting.$completed;

    assert.equal(router[destination].$exact.$active, true);
    assert.equal(router.sessions.$matched, false);
    assert.equal(router.transactions.$matched, false);
    assert.equal(router.$ableToBack, false);
    assert.equal(router.$ableToForward, false);
    assert.equal(router.$snapshot.operation, 'reset');
  });
}
