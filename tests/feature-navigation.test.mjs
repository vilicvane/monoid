import assert from 'node:assert/strict';
import {test} from 'node:test';

import {routra} from 'routra';

import {ROUTE_SCHEMA} from '../.bld/app/@routes.js';

async function createRouter() {
  const router = routra(ROUTE_SCHEMA, {});
  await router.features.$reset().$completed;
  return router;
}

function matchingRoots(router, activity) {
  return Object.keys(ROUTE_SCHEMA).filter(name => router[name][activity]);
}

test('Bundle setup opens distinct flows from Card in HTTP WebViews and retains a supplied flow ID', async t => {
  const webCrypto = globalThis.crypto;
  t.mock.getter(globalThis, 'crypto', () => ({
    getRandomValues: webCrypto.getRandomValues.bind(webCrypto),
  }));
  const router = await createRouter();
  const card = {id: '01020304', publicKey: `04${'01'.repeat(64)}`};
  await router.safe.card({card}).$push().$completed;

  const ids = [];
  for (let i = 0; i < 2; i++) {
    await router.safe.setupCard({card, createBundle: true}).$push().$completed;
    assert.equal(router.safe.setupCard.$exact.$active, true);
    assert.deepEqual({...router.$state.card}, card);
    assert.equal(router.$state.createBundle, true);
    assert.equal(typeof router.$state.bundleId, 'string');
    assert.ok(router.$state.bundleId.length > 0);
    ids.push(router.$state.bundleId);
    await router.$back().$completed;
    assert.equal(router.safe.card.$exact.$active, true);
  }
  assert.notEqual(ids[0], ids[1]);

  await router.safe
    .setupCard({card, createBundle: true, bundleId: ids[0]})
    .$push().$completed;
  assert.equal(router.$state.bundleId, ids[0]);
});

test('Card sync creates distinct HTTP-safe flows and preserves the card and supplied flow ID', async t => {
  const webCrypto = globalThis.crypto;
  t.mock.getter(globalThis, 'crypto', () => ({
    getRandomValues: webCrypto.getRandomValues.bind(webCrypto),
  }));
  const router = await createRouter();
  const card = {id: '01020304', publicKey: `04${'01'.repeat(64)}`};
  await router.safe.card({card}).$push().$completed;

  const ids = [];
  for (let i = 0; i < 2; i++) {
    await router.safe.syncCards({card}).$push().$completed;
    assert.equal(router.safe.syncCards.$exact.$active, true);
    assert.deepEqual({...router.$state.card}, card);
    assert.equal(typeof router.$state.syncId, 'string');
    assert.ok(router.$state.syncId.length > 0);
    ids.push(router.$state.syncId);
    await router.$back().$completed;
    assert.equal(router.safe.card.$exact.$active, true);
  }
  assert.notEqual(ids[0], ids[1]);

  await router.safe.syncCards({card, syncId: ids[0]}).$push().$completed;
  assert.equal(router.$state.syncId, ids[0]);
  assert.deepEqual({...router.$state.card}, card);
});

test('Bundle extension opens without randomUUID and returns through Card Applets to the same flow', async t => {
  const webCrypto = globalThis.crypto;
  t.mock.getter(globalThis, 'crypto', () => ({
    getRandomValues: webCrypto.getRandomValues.bind(webCrypto),
  }));
  const router = await createRouter();
  const card = {
    id: '01020304',
    publicKey: `04${'01'.repeat(64)}`,
    bundle: 'ab'.repeat(32),
  };
  await router.safe.card({card}).$push().$completed;
  await router.safe.extendBundle({card}).$push().$completed;
  const extensionId = router.$state.extensionId;
  assert.ok(extensionId);
  assert.equal(router.safe.extendBundle.$exact.$active, true);
  assert.deepEqual({...router.$state.card}, card);

  await router.cardApplets({returnTo: 'bundleExtension', extensionId}).$push()
    .$completed;
  const backToExtension = router.$backTo(router.safe.extendBundle.$exact);
  assert.equal(typeof backToExtension, 'function');
  await backToExtension().$completed;
  assert.equal(router.$state.extensionId, extensionId);
  assert.deepEqual({...router.$state.card}, card);
  await router.$backTo(router.safe.card.$exact)().$completed;
  await router.safe.extendBundle({card}).$push().$completed;
  assert.notEqual(router.$state.extensionId, extensionId);
});

for (const feature of [
  'sessions',
  'ethereum',
  'solana',
  'bitcoin',
  'cardApplets',
]) {
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

  const opening = router.ethereum.$push();
  const [entering] = router.ethereum.$exact.$view().$entries;
  const enteringTransition = entering.$transition;
  enteringTransition({entering: true});
  context.after(() => enteringTransition({entering: false}));

  assert.equal(leaving.$leaving.$operation, 'push');
  assert.equal(entering.$entering.$operation, 'push');
  assert.equal(router.sessions.$active, true);
  assert.equal(router.ethereum.$active, false);
  assert.equal(router.sessions.$matched, true);
  assert.equal(router.ethereum.$matched, true);
  assert.deepEqual(matchingRoots(router, '$transition'), ['ethereum']);

  entering.$entering.$complete();
  await Promise.resolve();
  assert.equal(router.sessions.$active, true);
  assert.equal(router.ethereum.$active, false);

  leaving.$leaving.$complete();
  await opening.$completed;
  assert.equal(router.sessions.$matched, false);
  assert.equal(router.ethereum.$exact.$active, true);
  assert.deepEqual(matchingRoots(router, '$transition'), []);
  assert.deepEqual(sessionsView.$entries, []);
});

test('a navigation reset exposes its new destination while an interrupted swipe still targets a feature', async () => {
  const router = await createRouter();
  await router.sessions.$push().$completed;
  await router.solana.$push().$completed;

  const swipe = router.$back.$switch({progress: 0.4});
  assert.deepEqual(matchingRoots(router, '$switching'), ['sessions']);
  assert.deepEqual(matchingRoots(router, '$active'), ['solana']);

  const resetting = router.safe.$reset();
  assert.deepEqual(matchingRoots(router, '$transition'), ['safe']);
  assert.deepEqual(matchingRoots(router, '$switching'), ['sessions']);

  swipe.$abort();
  assert.deepEqual(matchingRoots(router, '$transition'), ['safe']);
  assert.deepEqual(matchingRoots(router, '$switching'), []);
  await resetting.$completed;
  assert.deepEqual(matchingRoots(router, '$active'), ['safe']);
});

for (const [feature, address, detail] of [
  [
    'ethereum',
    '0x3535353535353535353535353535353535353535',
    {chainId: 'eip155:1', hash: `0x${'1'.repeat(64)}`},
  ],
  [
    'solana',
    '11111111111111111111111111111111',
    {chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', id: 'signature'},
  ],
]) {
  test(`${feature} history preserves wallet and detail state through cancelled swipes, back and forward`, async () => {
    const router = await createRouter();
    const route = router[feature];

    await route.$push().$completed;
    await route.wallet({address}).$push().$completed;
    await route.wallet.transaction(detail).$push().$completed;

    assert.equal(route.wallet.transaction.$exact.$active, true);
    assert.deepEqual(matchingRoots(router, '$matched'), [feature]);
    assert.deepEqual({...router.$state}, {address, ...detail});

    const cancelled = router.$back.$switch({progress: 0.4});
    assert.equal(route.wallet.transaction.$exact.$active, true);
    assert.equal(route.wallet.$exact.$switching, true);
    cancelled.$abort();
    assert.equal(route.wallet.transaction.$exact.$active, true);
    assert.deepEqual({...router.$state}, {address, ...detail});

    await router.$back().$completed;
    assert.equal(route.wallet.$exact.$active, true);
    assert.deepEqual({...router.$state}, {address});
    assert.deepEqual(matchingRoots(router, '$matched'), [feature]);

    await router.$back().$completed;
    assert.equal(route.$exact.$active, true);
    await router.$back().$completed;
    assert.equal(router.features.$exact.$active, true);

    await router.$forward().$completed;
    await router.$forward().$completed;
    await router.$forward().$completed;
    assert.equal(route.wallet.transaction.$exact.$active, true);
    assert.deepEqual({...router.$state}, {address, ...detail});
    assert.deepEqual(matchingRoots(router, '$matched'), [feature]);
  });
}

for (const kind of ['speed-up', 'cancel']) {
  test(`Ethereum ${kind} replacement returns to its detail without matching Solana`, async () => {
    const router = await createRouter();
    const address = '0x3535353535353535353535353535353535353535';
    const detail = {chainId: 'eip155:1', hash: `0x${'1'.repeat(64)}`};

    await router.ethereum.$push().$completed;
    await router.ethereum.wallet({address}).$push().$completed;
    await router.ethereum.wallet.transaction(detail).$push().$completed;
    await router.ethereum.wallet.transaction.replace({kind}).$push().$completed;
    assert.deepEqual({...router.$state}, {address, ...detail, kind});
    assert.deepEqual(matchingRoots(router, '$matched'), ['ethereum']);

    const cancelled = router.$back.$switch({progress: 0.4});
    cancelled.$abort();
    assert.equal(
      router.ethereum.wallet.transaction.replace.$exact.$active,
      true,
    );
    assert.deepEqual({...router.$state}, {address, ...detail, kind});

    await router.$back().$completed;
    assert.equal(router.ethereum.wallet.transaction.$exact.$active, true);
    assert.deepEqual({...router.$state}, {address, ...detail});
  });
}

for (const destination of ['features', 'scan', 'safe']) {
  test(`resetting to ${destination} clears the temporary feature and its history`, async () => {
    const router = await createRouter();
    await router.ethereum.$push().$completed;
    await router.ethereum
      .wallet({address: '0x3535353535353535353535353535353535353535'})
      .$push().$completed;

    const resetting = router[destination].$reset();
    assert.deepEqual(matchingRoots(router, '$transition'), [destination]);
    assert.equal(router.ethereum.$active, true);
    await resetting.$completed;

    assert.equal(router[destination].$exact.$active, true);
    assert.equal(router.sessions.$matched, false);
    assert.equal(router.ethereum.$matched, false);
    assert.equal(router.solana.$matched, false);
    assert.equal(router.$ableToBack, false);
    assert.equal(router.$ableToForward, false);
    assert.equal(router.$snapshot.operation, 'reset');
  });
}
