import assert from 'node:assert/strict';
import {test} from 'node:test';

import {reaction} from 'mobx';
import {routra} from 'routra';
import {BrowserRouterPlugin} from 'routra/browser';

// eslint-disable-next-line @mufan/scoped-modules -- Exercise startup routes without initializing platform services.
import {ROUTE_SCHEMA} from '../.bld/app/@routes.js';
// eslint-disable-next-line @mufan/scoped-modules, @mufan/import -- Exercise persisted preferences without initializing platform services.
import {AppPreferencesService} from '../.bld/app/@services/app-preferences-service.js';

function storageFixture(context, initial) {
  let saved = initial;

  return {
    get: context.mock.fn(async key => {
      assert.equal(key, 'defaultFeature');
      return saved;
    }),
    set: context.mock.fn(async (key, value) => {
      assert.equal(key, 'defaultFeature');
      saved = value;
    }),
    remove: context.mock.fn(async key => {
      assert.equal(key, 'defaultFeature');
      saved = undefined;
    }),
  };
}

function startupRouter(preferences, ref = '/') {
  const router = routra(ROUTE_SCHEMA, {});
  const history = {
    snapshot: {entries: [{ref, data: undefined}], active: 0},
    async restore(snapshot) {
      this.snapshot = snapshot;
    },
    listen(callback) {
      callback(this.snapshot, 'reset');
      return () => {};
    },
  };

  router.$use(
    new BrowserRouterPlugin({
      default: router[preferences.defaultFeature ?? 'features'],
      history,
    }),
  );

  return {router, history};
}

test('missing and unknown preferences fall back to Home without rewriting storage', async context => {
  for (const initial of [
    undefined,
    null,
    'transactions',
    'removed-feature',
    {},
    1,
  ]) {
    const storage = storageFixture(context, initial);
    const service = await AppPreferencesService.create(storage);
    assert.equal(service.defaultFeature, undefined);
    assert.equal(startupRouter(service).router.features.$exact.$active, true);
    assert.equal(storage.set.mock.callCount(), 0);
    assert.equal(storage.remove.mock.callCount(), 0);
  }
});

test('a changed default feature survives reopening and clearing removes the preference', async context => {
  const storage = storageFixture(context);
  const service = await AppPreferencesService.create(storage);

  await service.setDefaultFeature('sessions');
  assert.equal(service.defaultFeature, 'sessions');
  const reopened = await AppPreferencesService.create(storage);
  assert.equal(reopened.defaultFeature, 'sessions');

  await reopened.setDefaultFeature('ethereum');
  assert.equal(
    (await AppPreferencesService.create(storage)).defaultFeature,
    'ethereum',
  );

  await reopened.setDefaultFeature(undefined);
  assert.equal(reopened.defaultFeature, undefined);
  assert.equal(
    (await AppPreferencesService.create(storage)).defaultFeature,
    undefined,
  );
  assert.equal(storage.set.mock.callCount(), 2);
  assert.equal(storage.remove.mock.callCount(), 1);
});

test('storage read failures propagate without replacing the saved preference', async context => {
  const storage = storageFixture(context, 'sessions');
  const failure = new Error('Preference read failed');
  storage.get.mock.mockImplementationOnce(async () => {
    throw failure;
  });

  await assert.rejects(AppPreferencesService.create(storage), failure);
  assert.equal(storage.set.mock.callCount(), 0);
  assert.equal(storage.remove.mock.callCount(), 0);
  assert.equal(
    (await AppPreferencesService.create(storage)).defaultFeature,
    'sessions',
  );
});

test('failed writes and removals retain the committed choice and allow later changes', async context => {
  const storage = storageFixture(context, 'sessions');
  const service = await AppPreferencesService.create(storage);
  const changes = [];
  context.after(
    reaction(
      () => service.defaultFeature,
      value => changes.push(value),
    ),
  );
  const failure = new Error('Preference write failed');
  storage.set.mock.mockImplementationOnce(async () => {
    throw failure;
  });

  await assert.rejects(service.setDefaultFeature('solana'), failure);
  assert.equal(service.defaultFeature, 'sessions');
  assert.equal(await storage.get('defaultFeature'), 'sessions');

  storage.remove.mock.mockImplementationOnce(async () => {
    throw failure;
  });
  await assert.rejects(service.setDefaultFeature(undefined), failure);
  assert.equal(service.defaultFeature, 'sessions');
  assert.deepEqual(changes, []);

  await service.setDefaultFeature('solana');
  assert.equal(service.defaultFeature, 'solana');
  assert.deepEqual(changes, ['solana']);
  assert.equal(
    (await AppPreferencesService.create(storage)).defaultFeature,
    'solana',
  );
});

test('rapid changes persist in order and become observable only after each successful write', async context => {
  const storage = storageFixture(context);
  const service = await AppPreferencesService.create(storage);
  const changes = [];
  context.after(
    reaction(
      () => service.defaultFeature,
      value => changes.push(value),
    ),
  );
  const started = [Promise.withResolvers(), Promise.withResolvers()];
  const release = [Promise.withResolvers(), Promise.withResolvers()];
  const save = storage.set;
  let writeIndex = 0;
  storage.set = context.mock.fn(async (...args) => {
    const index = writeIndex++;
    started[index].resolve();
    await release[index].promise;
    await save(...args);
  });

  const first = service.setDefaultFeature('sessions');
  const second = service.setDefaultFeature('ethereum');
  const cleared = service.setDefaultFeature(undefined);
  await started[0].promise;
  assert.equal(storage.set.mock.callCount(), 1);
  assert.equal(storage.remove.mock.callCount(), 0);
  assert.equal(service.defaultFeature, undefined);
  assert.deepEqual(changes, []);

  release[0].resolve();
  await first;
  await started[1].promise;
  assert.equal(service.defaultFeature, 'sessions');
  assert.deepEqual(changes, ['sessions']);
  assert.equal(storage.remove.mock.callCount(), 0);

  release[1].resolve();
  await Promise.all([second, cleared]);
  assert.deepEqual(changes, ['sessions', 'ethereum', undefined]);
  assert.equal(service.defaultFeature, undefined);
  assert.equal(
    (await AppPreferencesService.create(storage)).defaultFeature,
    undefined,
  );
});

test('a queued preference change still completes after an earlier queued write fails', async context => {
  const storage = storageFixture(context, 'sessions');
  const service = await AppPreferencesService.create(storage);
  const failure = new Error('Preference write failed');
  storage.set.mock.mockImplementationOnce(async () => {
    throw failure;
  });

  const failed = service.setDefaultFeature('solana');
  const recovered = service.setDefaultFeature(undefined);
  await Promise.all([assert.rejects(failed, failure), recovered]);
  assert.equal(service.defaultFeature, undefined);
  assert.equal(storage.remove.mock.callCount(), 1);
  assert.equal(
    (await AppPreferencesService.create(storage)).defaultFeature,
    undefined,
  );
});

for (const saved of [undefined, 'sessions', 'ethereum', 'solana', 'bitcoin']) {
  test(`startup default ${saved ?? 'Home'} applies only to the root URL and preserves explicit deep links`, async context => {
    const preferences = await AppPreferencesService.create(
      storageFixture(context, saved),
    );
    const {router, history} = startupRouter(preferences);
    assert.deepEqual(router.$path, [saved ?? 'features']);

    await router.features.$reset().$completed;
    assert.equal(router.features.$exact.$active, true);
    assert.equal(history.snapshot.entries[0].ref, saved ? '/features' : '/');

    const address = '0x3535353535353535353535353535353535353535';
    const hash = `0x${'1'.repeat(64)}`;
    const walletRef = `/ethereum/wallet:address=${address}`;
    const detailRef = `${walletRef}/transaction:chainId=eip155%3A1&hash=${hash}`;
    const solanaAddress = '11111111111111111111111111111111';
    const solanaChainId = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
    const solanaWalletRef = `/solana/wallet:address=${solanaAddress}`;
    const solanaDetailRef = `${solanaWalletRef}/transaction:chainId=${encodeURIComponent(solanaChainId)}&id=signature`;

    for (const [ref, path, state] of [
      ['/features', ['features'], {}],
      ['/sessions', ['sessions'], {}],
      ['/ethereum', ['ethereum'], {}],
      ['/solana', ['solana'], {}],
      [walletRef, ['ethereum', 'wallet'], {address}],
      [
        detailRef,
        ['ethereum', 'wallet', 'transaction'],
        {address, chainId: 'eip155:1', hash},
      ],
      [
        `${detailRef}/replace:kind=cancel`,
        ['ethereum', 'wallet', 'transaction', 'replace'],
        {address, chainId: 'eip155:1', hash, kind: 'cancel'},
      ],
      [solanaWalletRef, ['solana', 'wallet'], {address: solanaAddress}],
      [
        solanaDetailRef,
        ['solana', 'wallet', 'transaction'],
        {address: solanaAddress, chainId: solanaChainId, id: 'signature'},
      ],
    ]) {
      const explicit = startupRouter(preferences, ref).router;
      assert.deepEqual(explicit.$path, path);
      assert.deepEqual({...explicit.$state}, state);
    }
  });
}

test('changing the saved choice on Home affects the next launch without navigating the current one', async context => {
  const storage = storageFixture(context, 'sessions');
  const preferences = await AppPreferencesService.create(storage);
  const {router, history} = startupRouter(preferences, '/features');

  await preferences.setDefaultFeature('solana');
  assert.equal(router.features.$exact.$active, true);
  assert.equal(history.snapshot.entries[0].ref, '/features');
  assert.equal(
    startupRouter(await AppPreferencesService.create(storage)).router.solana
      .$exact.$active,
    true,
  );

  await router.sessions.$reset().$completed;
  assert.equal(history.snapshot.entries[0].ref, '/');
  await preferences.setDefaultFeature(undefined);
  assert.equal(router.sessions.$exact.$active, true);
  assert.equal(
    startupRouter(await AppPreferencesService.create(storage)).router.features
      .$exact.$active,
    true,
  );
});
