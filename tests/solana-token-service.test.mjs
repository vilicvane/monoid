import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {base58} from '@scure/base';
import {reaction} from 'mobx';

import {SolanaTokenService} from '../.bld/app/@services/solana-token-service.js';

const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const NOW = 1_000_000_000;
const DAY = 86400000;
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN = {
  address: MINT,
  name: 'USD Coin',
  symbol: 'USDC',
  decimals: 6,
  logoURI: 'https://example.com/usdc.png',
};

function mint(index) {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, index);
  return base58.encode(bytes);
}

function entry(address = MINT, changes = {}) {
  return {
    id: address,
    name: TOKEN.name,
    symbol: TOKEN.symbol,
    decimals: TOKEN.decimals,
    icon: TOKEN.logoURI,
    tokenProgram: TOKEN_PROGRAM,
    ...changes,
  };
}

function storage(context, cache) {
  return {
    get: context.mock.fn(async key => {
      assert.equal(key, 'solanaTokenMetadata');
      return structuredClone(cache);
    }),
    set: context.mock.fn(async (key, value) => {
      assert.equal(key, 'solanaTokenMetadata');
      cache = structuredClone(value);
    }),
  };
}

test('never queries another network or a malformed mint', async context => {
  const fetch = context.mock.fn(async () => {
    throw new Error('Unexpected fetch');
  });
  const service = new SolanaTokenService(storage(context), undefined, fetch);

  await service.resolve(DEVNET, [MINT]);
  await service.resolve('eip155:1', [MINT]);
  await service.resolve(MAINNET, [
    '',
    'USDC',
    '0x123',
    base58.encode(new Uint8Array(31)),
  ]);

  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(service.getToken(DEVNET, MINT), undefined);
});

test('accepts only exact requested classic mints with valid text and precision', async context => {
  const addresses = Array.from({length: 9}, (_, index) => mint(index + 1));
  const fetch = context.mock.fn(async () =>
    Response.json([
      entry(MINT.toLowerCase()),
      entry(mint(99)),
      entry(addresses[0], {
        tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      }),
      entry(addresses[1], {decimals: 256}),
      entry(addresses[2], {decimals: 1.5}),
      entry(addresses[3], {name: ' '}),
      entry(addresses[4], {symbol: 'x'.repeat(33)}),
      entry(addresses[5], {icon: 'http://example.com/icon.png'}),
      entry(addresses[6], {icon: 'https://user:secret@example.com/icon.png'}),
      entry(addresses[7], {icon: 'not a URL'}),
      entry(addresses[8], {name: ' Token ', symbol: ' TKN ', decimals: 0}),
    ]),
  );
  const service = new SolanaTokenService(storage(context), undefined, fetch);

  await service.resolve(MAINNET, [MINT, ...addresses]);

  assert.equal(service.getToken(MAINNET, MINT), undefined);
  assert.equal(service.getToken(MAINNET, mint(99)), undefined);
  for (const address of addresses.slice(0, 5)) {
    assert.equal(service.getToken(MAINNET, address), undefined);
  }
  for (const address of addresses.slice(5, 8)) {
    assert.equal(service.getToken(MAINNET, address).logoURI, undefined);
  }
  assert.deepEqual(service.getToken(MAINNET, addresses[8]), {
    address: addresses[8],
    name: 'Token',
    symbol: 'TKN',
    decimals: 0,
    logoURI: TOKEN.logoURI,
  });
});

test('persists successes, notifies observers and reuses them after an offline restart', async context => {
  context.mock.timers.enable({apis: ['Date'], now: NOW});
  const fetch = context.mock.method(globalThis, 'fetch', async () =>
    Response.json([entry()]),
  );
  const saved = storage(context);
  const service = await SolanaTokenService.create(saved);
  const changes = [];
  const stop = reaction(
    () => service.getToken(MAINNET, MINT),
    token => changes.push(token),
  );
  context.after(stop);

  await service.resolve(MAINNET, [MINT, MINT]);
  assert.deepEqual(changes, [TOKEN]);
  assert.equal(saved.set.mock.callCount(), 1);
  assert.equal(service.getToken(MAINNET, MINT.toLowerCase()), undefined);

  fetch.mock.mockImplementation(async () => {
    throw new Error('offline');
  });
  const restarted = await SolanaTokenService.create(saved);
  await restarted.resolve(MAINNET, [MINT]);
  assert.deepEqual(restarted.getToken(MAINNET, MINT), TOKEN);
  assert.equal(restarted.getToken(DEVNET, MINT), undefined);
  assert.equal(fetch.mock.callCount(), 1);
});

test('coalesces missing lookups and backs off after failures while retaining cached text', async context => {
  context.mock.timers.enable({apis: ['Date'], now: NOW});
  let fail = true;
  const fetch = context.mock.fn(async () => {
    if (fail) throw new Error('offline');
    return Response.json([entry()]);
  });
  const service = new SolanaTokenService(
    storage(context),
    {[MINT]: {token: TOKEN, updatedAt: NOW - DAY}},
    fetch,
  );
  await Promise.all([
    service.resolve(MAINNET, [MINT]),
    service.resolve(MAINNET, [MINT]),
  ]);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(service.getToken(MAINNET, MINT), TOKEN);
  await service.resolve(MAINNET, [MINT]);
  assert.equal(fetch.mock.callCount(), 1);

  context.mock.timers.setTime(NOW + 300000);
  fail = false;
  await service.resolve(MAINNET, [MINT]);
  assert.equal(fetch.mock.callCount(), 2);
  await service.resolve(MAINNET, [MINT]);
  assert.equal(fetch.mock.callCount(), 2);
});

test('serializes all batches, limits them to 100 and spaces starts by two seconds', async context => {
  context.mock.timers.enable({apis: ['Date', 'setTimeout'], now: NOW});
  const addresses = Array.from({length: 102}, (_, index) => mint(index + 1));
  const requests = [];
  const fetch = context.mock.fn(async url => {
    const queried = new URL(url).searchParams.get('query').split(',');
    requests.push({time: Date.now(), addresses: queried});
    return Response.json([]);
  });
  const service = new SolanaTokenService(storage(context), undefined, fetch);
  const first = service.resolve(MAINNET, addresses.slice(0, 101));
  const overlapping = service.resolve(MAINNET, [addresses[0], addresses[101]]);
  await setImmediate();
  assert.equal(requests.length, 1);

  context.mock.timers.tick(1999);
  await setImmediate();
  assert.equal(requests.length, 1);
  context.mock.timers.tick(1);
  await setImmediate();
  assert.equal(requests.length, 2);
  context.mock.timers.tick(2000);
  await Promise.all([first, overlapping]);

  assert.deepEqual(
    requests.map(request => request.time),
    [NOW, NOW + 2000, NOW + 4000],
  );
  assert.deepEqual(
    requests.map(request => request.addresses.length),
    [100, 1, 1],
  );
  assert.deepEqual(
    requests.flatMap(request => request.addresses),
    addresses,
  );
  await service.resolve(MAINNET, addresses);
  assert.equal(requests.length, 3);
});

test('aborts a stalled metadata fetch without rejecting the review', async context => {
  context.mock.timers.enable({apis: ['Date', 'setTimeout'], now: NOW});
  let signal;
  const fetch = context.mock.fn((_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    });
  });
  const service = new SolanaTokenService(storage(context), undefined, fetch);
  const pending = service.resolve(MAINNET, [MINT]);
  await setImmediate();
  context.mock.timers.tick(10000);
  await pending;

  assert.equal(signal.aborted, true);
  assert.equal(service.getToken(MAINNET, MINT), undefined);
  await service.resolve(MAINNET, [MINT]);
  assert.equal(fetch.mock.callCount(), 1);
});

test('HTTP errors and malformed responses stay optional and retry after five minutes', async context => {
  context.mock.timers.enable({apis: ['Date'], now: NOW});
  const responses = [
    new Response('', {status: 429}),
    new Response('not JSON'),
    Response.json({tokens: [entry()]}),
    Response.json([entry()]),
  ];
  const fetch = context.mock.fn(async () => responses.shift());
  const service = new SolanaTokenService(storage(context), undefined, fetch);

  for (let attempt = 0; attempt < 3; attempt++) {
    context.mock.timers.setTime(NOW + attempt * 300000);
    await service.resolve(MAINNET, [MINT]);
    assert.equal(service.getToken(MAINNET, MINT), undefined);
    await service.resolve(MAINNET, [MINT]);
    assert.equal(fetch.mock.callCount(), attempt + 1);
  }
  context.mock.timers.setTime(NOW + 900000);
  await service.resolve(MAINNET, [MINT]);
  assert.deepEqual(service.getToken(MAINNET, MINT), TOKEN);
});

test('unavailable persistence does not prevent an in-memory metadata update', async context => {
  context.mock.method(console, 'warn', () => {});
  const saved = storage(context);
  saved.set.mock.mockImplementation(async () => {
    throw new Error('Storage unavailable');
  });
  const service = new SolanaTokenService(saved, undefined, async () =>
    Response.json([entry()]),
  );

  await service.resolve(MAINNET, [MINT]);
  assert.deepEqual(service.getToken(MAINNET, MINT), TOKEN);
  assert.equal(saved.set.mock.callCount(), 1);
});
