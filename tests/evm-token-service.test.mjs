import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Interface} from 'ethers';
import {reaction} from 'mobx';

import {EvmTokenService} from '../.bld/app/@services/evm-token-service.js';

const TOKEN = {
  chainId: 1,
  address: '0x1111111111111111111111111111111111111111',
  name: 'Token',
  symbol: 'TKN',
  decimals: 6,
};
const NOW = 1_000_000_000;
const DAY = 86400000;
const noRPC = {
  async getRPC() {
    throw new Error('Unexpected RPC');
  },
};

function storage(context, cache) {
  return {
    get: context.mock.fn(async key => {
      assert.equal(key, 'evmTokenList');
      return cache;
    }),
    set: context.mock.fn(async (key, value) => {
      assert.equal(key, 'evmTokenList');
      cache = structuredClone(value);
    }),
  };
}

test('uses a fresh persisted catalog offline and looks up exact chain plus case-insensitive address', async context => {
  context.mock.timers.enable({apis: ['Date'], now: NOW});
  const fetch = context.mock.method(globalThis, 'fetch', async () => {
    throw new Error('offline');
  });
  const service = await EvmTokenService.create(
    storage(context, {tokens: [TOKEN], updatedAt: NOW}),
    noRPC,
  );
  assert.equal(
    service.getToken('eip155:1', TOKEN.address.toUpperCase()).symbol,
    'TKN',
  );
  assert.equal(service.getToken('eip155:10', TOKEN.address), undefined);
  await service.refresh();
  assert.equal(fetch.mock.callCount(), 0);
});

test('deduplicates contract lookups, keeps catalog precedence and retries failed lookups', async context => {
  context.mock.timers.enable({apis: ['Date'], now: NOW});
  const iface = new Interface([
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
  ]);
  let available = true;
  const chain = {
    getRPC: context.mock.fn(async () => ({
      async call({data}) {
        if (!available) throw new Error('Offline');
        const fn = iface.getFunction(data.slice(0, 10));
        return iface.encodeFunctionResult(fn, [
          fn.name === 'name'
            ? 'On-chain token'
            : fn.name === 'symbol'
              ? 'TOKEN'
              : 6,
        ]);
      },
    })),
  };
  const service = new EvmTokenService(storage(context), chain, {
    tokens: [TOKEN],
    updatedAt: NOW,
  });
  await service.resolve('eip155:1', TOKEN.address);
  assert.equal(chain.getRPC.mock.callCount(), 0);
  const pending = service.resolve('eip155:10', TOKEN.address);
  assert.equal(
    service.resolve('eip155:10', TOKEN.address.toUpperCase()),
    pending,
  );
  await pending;
  assert.equal(chain.getRPC.mock.callCount(), 1);
  assert.equal(service.isListed('eip155:10', TOKEN.address), false);
  assert.equal(
    service.getToken('eip155:10', TOKEN.address).name,
    'On-chain token',
  );
  assert.equal(service.getToken('eip155:1', TOKEN.address).name, TOKEN.name);
  available = false;
  await service.resolve('eip155:137', TOKEN.address);
  assert.equal(service.getToken('eip155:137', TOKEN.address), undefined);
  await service.resolve('eip155:137', TOKEN.address);
  assert.equal(chain.getRPC.mock.callCount(), 2);
  available = true;
  context.mock.timers.setTime(NOW + 300000);
  await service.resolve('eip155:137', TOKEN.address);
  assert.equal(
    service.getToken('eip155:137', TOKEN.address).name,
    'On-chain token',
  );
});

test('shares refresh, atomically replaces the catalog, persists it, and notifies observers', async context => {
  context.mock.timers.enable({apis: ['Date'], now: NOW});
  let resolve;
  const fetch = context.mock.method(
    globalThis,
    'fetch',
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const saved = storage(context);
  const service = new EvmTokenService(saved, noRPC, {
    tokens: [TOKEN],
    updatedAt: NOW - DAY,
  });
  const changes = [];
  const stop = reaction(
    () => service.getToken('eip155:1', TOKEN.address),
    value => changes.push(value),
  );
  context.after(stop);
  const pending = service.refresh();
  assert.equal(service.refresh(), pending);
  assert.equal(service.getToken('eip155:1', TOKEN.address).decimals, 6);
  resolve(Response.json({tokens: [{...TOKEN, chainId: 10, decimals: 18}]}));
  await pending;
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(saved.set.mock.callCount(), 1);
  assert.equal(service.getToken('eip155:1', TOKEN.address), undefined);
  assert.equal(service.getToken('eip155:10', TOKEN.address).decimals, 18);
  assert.deepEqual(changes, [undefined]);
  await service.refresh();
  assert.equal(fetch.mock.callCount(), 1);
});

test('network or invalid catalog failures retain old metadata and back off before retrying', async context => {
  context.mock.timers.enable({apis: ['Date'], now: NOW});
  let response = new Response('', {status: 503});
  const fetch = context.mock.method(globalThis, 'fetch', async () => response);
  const saved = storage(context);
  const service = new EvmTokenService(saved, noRPC, {
    tokens: [TOKEN],
    updatedAt: NOW - DAY,
  });
  await assert.rejects(service.refresh(), /503/);
  await service.refresh();
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(service.getToken('eip155:1', TOKEN.address).symbol, 'TKN');
  context.mock.timers.setTime(NOW + 300000);
  response = Response.json({
    tokens: [TOKEN, {...TOKEN, chainId: 10, decimals: -1}],
  });
  await assert.rejects(service.refresh(), /Invalid/);
  assert.equal(service.getToken('eip155:1', TOKEN.address).symbol, 'TKN');
  assert.equal(service.getToken('eip155:10', TOKEN.address), undefined);
  assert.equal(saved.set.mock.callCount(), 0);
});
