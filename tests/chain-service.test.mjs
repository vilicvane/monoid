/* global globalThis */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {reaction} from 'mobx';

// eslint-disable-next-line @mufan/scoped-modules, @mufan/import -- Exercise the service without initializing platform services.
import {ChainService} from '../.bld/app/@services/chain-service.js';

const NOW = 1_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const RETRY_DELAY = 5 * 60 * 1000;
const DIRECTORY = [
  {
    chainId: 1,
    name: 'Ethereum Mainnet',
    chainSlug: 'ethereum',
    nativeCurrency: {symbol: 'ETH', decimals: 18},
    rpc: ['https://unused.example'],
  },
  {
    chainId: 987654321,
    name: 'Example Network',
    chainSlug: 'example',
    nativeCurrency: {symbol: 'COIN', decimals: 6},
  },
];

function createStorage(context, cache) {
  let saved = cache;

  return {
    get: context.mock.fn(async key => {
      assert.equal(key, 'chainDirectory');
      return saved;
    }),
    set: context.mock.fn(async (key, value) => {
      assert.equal(key, 'chainDirectory');
      saved = structuredClone(value);
    }),
  };
}

function mockFetch(
  context,
  implementation = async () => Response.json(DIRECTORY),
) {
  return context.mock.method(globalThis, 'fetch', implementation);
}

test('fresh cached names and built-in fallbacks are available without a network request', async context => {
  context.mock.timers.enable({apis: ['Date'], now: NOW});
  const fetch = mockFetch(context);
  const cache = {
    updatedAt: NOW - DAY + 1,
    names: {'eip155:987654321': 'Cached Network'},
    icons: {'eip155:987654321': 'https://icons.example/cached.jpg'},
  };
  const storage = createStorage(context, cache);
  const service = await ChainService.create(storage);

  assert.equal(service.getChainName('eip155:987654321'), 'Cached Network');
  assert.ok(service.getChainName('eip155:1'));
  assert.ok(service.getChainIcon('eip155:1'));
  assert.equal(
    service.getChainIcon('eip155:987654321'),
    'https://icons.example/cached.jpg',
  );
  assert.equal(service.getChainName('eip155:999999999'), undefined);
  assert.equal(service.getChainIcon('eip155:999999999'), undefined);
  assert.deepEqual(service.getNativeCurrency('eip155:1'), {
    symbol: 'ETH',
    decimals: 18,
  });
  assert.equal(service.getNativeCurrency('eip155:987654321'), undefined);
  await service.refresh();
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(storage.set.mock.callCount(), 0);

  context.mock.timers.setTime(NOW + 1);
  await service.refresh();
  assert.equal(fetch.mock.callCount(), 1);
});

test('cached currency metadata is usable offline without guessing unknown currencies', async context => {
  context.mock.timers.enable({apis: ['Date'], now: NOW});
  const fetch = mockFetch(context);
  const cache = {
    updatedAt: NOW,
    names: {'eip155:987654321': 'Cached Network'},
    icons: {},
    currencies: {'eip155:987654321': {symbol: 'COIN', decimals: 6}},
  };
  const storage = createStorage(context, cache);
  const service = await ChainService.create(storage);

  assert.deepEqual(service.getNativeCurrency('eip155:987654321'), {
    symbol: 'COIN',
    decimals: 6,
  });
  assert.equal(service.getNativeCurrency('eip155:999999999'), undefined);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(storage.set.mock.callCount(), 0);
});

test('stale cache is returned immediately while one shared background request refreshes names', async context => {
  context.mock.timers.enable({apis: ['Date'], now: NOW});
  const download = Promise.withResolvers();
  const fetch = mockFetch(context, () => download.promise);
  const storage = createStorage(context, {
    updatedAt: NOW - DAY,
    names: {'eip155:987654321': 'Cached Network'},
    icons: {'eip155:987654321': 'https://icons.example/cached.jpg'},
  });
  const service = await ChainService.create(storage);
  assert.equal(service.getChainName('eip155:987654321'), 'Cached Network');
  assert.equal(fetch.mock.callCount(), 1);
  const refresh = service.refresh();
  assert.equal(refresh, service.refresh());
  assert.equal(
    fetch.mock.calls[0].arguments[0],
    'https://chainlist.org/rpcs.json',
  );

  const observed = [];
  const dispose = reaction(
    () => [
      service.getChainName('eip155:987654321'),
      service.getChainIcon('eip155:987654321'),
      service.getNativeCurrency('eip155:987654321'),
    ],
    metadata => observed.push(metadata),
  );
  download.resolve(Response.json(DIRECTORY));
  await refresh;

  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(observed, [
    [
      'Example Network',
      'https://icons.llamao.fi/icons/chains/rsz_example.jpg',
      {symbol: 'COIN', decimals: 6},
    ],
  ]);
  assert.deepEqual(storage.set.mock.calls[0].arguments, [
    'chainDirectory',
    {
      updatedAt: NOW,
      names: {
        'eip155:1': 'Ethereum Mainnet',
        'eip155:987654321': 'Example Network',
      },
      icons: {
        'eip155:1': 'https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg',
        'eip155:987654321':
          'https://icons.llamao.fi/icons/chains/rsz_example.jpg',
      },
      currencies: {
        'eip155:1': {symbol: 'ETH', decimals: 18},
        'eip155:987654321': {symbol: 'COIN', decimals: 6},
      },
    },
  ]);
  await service.refresh();
  assert.equal(fetch.mock.callCount(), 1);
  dispose();
});

test('first-run offline startup keeps built-in names and warns without blocking creation', async context => {
  context.mock.timers.enable({apis: ['Date'], now: NOW});
  const failure = new Error('Offline');
  const fetch = mockFetch(context, async () => {
    throw failure;
  });
  const warn = context.mock.method(console, 'warn', () => {});
  const storage = createStorage(context);
  const service = await ChainService.create(storage);
  await assert.rejects(service.refresh(), failure);

  assert.ok(service.getChainName('eip155:1'));
  assert.ok(service.getChainIcon('eip155:1'));
  assert.equal(storage.set.mock.callCount(), 0);
  assert.deepEqual(warn.mock.calls[0].arguments, [failure]);
  await service.refresh();
  assert.equal(fetch.mock.callCount(), 1);
});

test('unavailable local storage does not block startup with built-in names', async context => {
  const download = Promise.withResolvers();
  mockFetch(context, () => download.promise);
  const warn = context.mock.method(console, 'warn', () => {});
  const failure = new Error('Storage unavailable');
  const storage = createStorage(context);
  storage.get.mock.mockImplementation(async () => {
    throw failure;
  });
  const service = await ChainService.create(storage);

  assert.ok(service.getChainName('eip155:1'));
  assert.deepEqual(warn.mock.calls[0].arguments, [failure]);
  download.resolve(Response.json(DIRECTORY));
  await service.refresh();
  assert.equal(service.getChainName('eip155:987654321'), 'Example Network');
  assert.equal(
    service.getChainIcon('eip155:987654321'),
    'https://icons.llamao.fi/icons/chains/rsz_example.jpg',
  );
});

test('a cache write failure keeps downloaded names usable without repeatedly downloading', async context => {
  context.mock.timers.enable({apis: ['Date'], now: NOW});
  const fetch = mockFetch(context);
  const warn = context.mock.method(console, 'warn', () => {});
  const storage = createStorage(context);
  const failure = new Error('Storage unavailable');
  storage.set.mock.mockImplementation(async () => {
    throw failure;
  });
  const service = new ChainService(storage);

  await service.refresh();
  assert.equal(service.getChainName('eip155:987654321'), 'Example Network');
  assert.deepEqual(warn.mock.calls[0].arguments, [failure]);
  await service.refresh();
  assert.equal(fetch.mock.callCount(), 1);
});

test('network, HTTP, JSON and invalid-directory failures preserve cache and retry after a short cooldown', async context => {
  context.mock.timers.enable({apis: ['Date'], now: NOW});
  for (const response of [
    async () => {
      throw new Error('Offline');
    },
    async () => new Response('', {status: 503}),
    async () => new Response('{broken'),
    async () => Response.json({error: 'Not a directory'}),
  ]) {
    const fetch = mockFetch(context, response);
    const cache = {
      updatedAt: NOW - DAY,
      names: {'eip155:987654321': 'Cached Network'},
      icons: {'eip155:987654321': 'https://icons.example/cached.jpg'},
    };
    const storage = createStorage(context, cache);
    const service = new ChainService(storage, cache);

    await assert.rejects(service.refresh());
    assert.equal(service.getChainName('eip155:987654321'), 'Cached Network');
    assert.equal(
      service.getChainIcon('eip155:987654321'),
      'https://icons.example/cached.jpg',
    );
    assert.equal(storage.set.mock.callCount(), 0);
    await service.refresh();
    assert.equal(fetch.mock.callCount(), 1);

    fetch.mock.mockImplementation(async () => Response.json(DIRECTORY));
    context.mock.timers.setTime(Date.now() + RETRY_DELAY);
    await service.refresh();
    assert.equal(fetch.mock.callCount(), 2);
    assert.equal(service.getChainName('eip155:987654321'), 'Example Network');
    fetch.mock.restore();
  }
});

test('a stalled request is aborted after ten seconds and a later refresh can retry', async context => {
  context.mock.timers.enable({apis: ['Date', 'setTimeout'], now: NOW});
  const storage = createStorage(context);
  const fetch = mockFetch(
    context,
    (_url, {signal}) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const service = new ChainService(storage);
  const refresh = service.refresh();
  const failure = assert.rejects(refresh, {name: 'AbortError'});
  context.mock.timers.tick(9999);
  assert.equal(fetch.mock.calls[0].arguments[1].signal.aborted, false);
  context.mock.timers.tick(1);
  await failure;

  assert.equal(storage.set.mock.callCount(), 0);
  await service.refresh();
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementation(async () => Response.json(DIRECTORY));
  context.mock.timers.tick(RETRY_DELAY);
  await service.refresh();
  assert.equal(fetch.mock.callCount(), 2);
});
