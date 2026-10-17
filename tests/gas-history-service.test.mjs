/* global globalThis */

import assert from 'node:assert/strict';
import {test} from 'node:test';

const {GasHistoryService} = await import(
  '../.bld/app/@services/gas-history-service.js'
);

const NOW = 1_800_000_000;
const CHAIN_ID = 'eip155:1';

function history() {
  return {
    chainId: CHAIN_ID,
    metric: 'baseFeePerGas',
    sampleIntervalSeconds: 300,
    updatedAt: NOW,
    windows: {
      '24h': {
        from: NOW - 86400,
        to: NOW,
        sampleCount: 288,
        expectedSampleCount: 288,
        status: 'ready',
        p25: '25',
        p75: '75',
      },
      '7d': {
        from: NOW - 604800,
        to: NOW,
        sampleCount: 288,
        expectedSampleCount: 2016,
        status: 'collecting',
        p25: null,
        p75: null,
      },
    },
  };
}

function mockFetch(
  context,
  implementation = async () => Response.json(history()),
) {
  context.mock.timers.enable({apis: ['Date'], now: NOW * 1000});
  return context.mock.method(globalThis, 'fetch', implementation);
}

test('only configured Ethereum mainnet history makes a request', async context => {
  const fetch = mockFetch(context);
  const configured = new GasHistoryService('https://gas.example/api/');

  assert.equal(await new GasHistoryService().getHistory(CHAIN_ID), undefined);
  assert.equal(await configured.getHistory('eip155:8453'), undefined);
  assert.equal(await configured.getHistory('eip155:11155111'), undefined);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(configured.supports(CHAIN_ID), true);
  assert.equal(configured.supports('eip155:8453'), false);

  assert.deepEqual(await configured.getHistory(CHAIN_ID), history());
  assert.equal(
    fetch.mock.calls[0].arguments[0],
    'https://gas.example/api/gas-history/eip155:1',
  );
});

test('concurrent reviews share a request and successful history is cached for five minutes', async context => {
  const download = Promise.withResolvers();
  const fetch = mockFetch(context, () => download.promise);
  const service = new GasHistoryService('https://gas.example/api');
  const first = service.getHistory(CHAIN_ID);
  const second = service.getHistory(CHAIN_ID);

  assert.equal(first, second);
  assert.equal(fetch.mock.callCount(), 1);
  download.resolve(Response.json(history()));
  assert.deepEqual(await first, history());
  assert.deepEqual(await second, history());

  context.mock.timers.setTime((NOW + 299) * 1000);
  assert.deepEqual(await service.getHistory(CHAIN_ID), history());
  assert.equal(fetch.mock.callCount(), 1);

  fetch.mock.mockImplementation(async () => Response.json(history()));
  context.mock.timers.setTime((NOW + 300) * 1000);
  assert.deepEqual(await service.getHistory(CHAIN_ID), history());
  assert.equal(fetch.mock.callCount(), 2);
});

test('a new installation can collect history without an available percentile or previous sample', async context => {
  const collecting = history();
  collecting.updatedAt = null;
  collecting.windows['24h'] = {
    ...collecting.windows['24h'],
    sampleCount: 0,
    status: 'collecting',
    p25: null,
    p75: null,
  };
  collecting.windows['7d'].sampleCount = 0;
  mockFetch(context, async () => Response.json(collecting));

  assert.deepEqual(
    await new GasHistoryService('https://gas.example/api').getHistory(CHAIN_ID),
    collecting,
  );
});

test('readiness uses backend coverage rather than requiring every sampling interval', async context => {
  const covered = history();
  covered.windows['24h'].sampleCount = 270;
  covered.windows['24h'].p25 = '0';
  covered.windows['24h'].p75 = String(2n ** 200n);
  mockFetch(context, async () => Response.json(covered));

  assert.deepEqual(
    await new GasHistoryService('https://gas.example/api').getHistory(CHAIN_ID),
    covered,
  );
});

test('stale and future timestamps or shifted window boundaries cannot classify gas', async context => {
  const fetch = mockFetch(context);

  for (const mutate of [
    value => {
      value.updatedAt = NOW - 901;
    },
    value => {
      value.updatedAt = NOW + 1;
    },
    value => {
      value.updatedAt = null;
    },
    value => {
      value.updatedAt = NOW * 1000;
    },
    value => {
      value.windows['24h'].from += 1;
    },
    value => {
      value.windows['24h'].from += 1;
      value.windows['24h'].to += 1;
    },
    value => {
      value.windows['24h'].from -= 901;
      value.windows['24h'].to -= 901;
    },
    value => {
      value.windows['7d'].to = null;
    },
  ]) {
    const value = history();
    mutate(value);
    fetch.mock.mockImplementation(async () => Response.json(value));

    assert.equal(
      await new GasHistoryService('https://gas.example/api').getHistory(
        CHAIN_ID,
      ),
      undefined,
    );
  }
});

test('history that expires inside the five-minute cache lifetime is not reused', async context => {
  const value = history();
  value.updatedAt = NOW - 899;
  const fetch = mockFetch(context, async () => Response.json(value));
  const service = new GasHistoryService('https://gas.example/api');

  assert.deepEqual(await service.getHistory(CHAIN_ID), value);
  context.mock.timers.setTime((NOW + 2) * 1000);
  assert.equal(await service.getHistory(CHAIN_ID), undefined);
  assert.equal(fetch.mock.callCount(), 1);
});

test('wrong metrics, chains, sample counts and malformed percentiles are unavailable', async context => {
  const fetch = mockFetch(context);
  const malformed = [null, {}, [], 'history'];

  for (const mutate of [
    value => {
      value.chainId = 'eip155:8453';
    },
    value => {
      value.metric = 'gasPrice';
    },
    value => {
      value.sampleIntervalSeconds = 60;
    },
    value => {
      value.windows['24h'].sampleCount = -1;
    },
    value => {
      value.windows['24h'].sampleCount = 289;
    },
    value => {
      value.windows['24h'].expectedSampleCount = 100;
    },
    value => {
      value.windows['24h'].status = 'unknown';
    },
    value => {
      value.windows['24h'].p25 = '76';
    },
    value => {
      value.windows['24h'].p25 = '-1';
    },
    value => {
      value.windows['24h'].p25 = '1.5';
    },
    value => {
      value.windows['24h'].p25 = 25;
    },
    value => {
      value.windows['24h'].p75 = null;
    },
  ]) {
    const value = history();
    mutate(value);
    malformed.push(value);
  }

  for (const value of malformed) {
    fetch.mock.mockImplementation(async () => Response.json(value));

    assert.equal(
      await new GasHistoryService('https://gas.example/api').getHistory(
        CHAIN_ID,
      ),
      undefined,
    );
  }
});

test('network, HTTP and malformed JSON failures are optional and allow a later retry', async context => {
  const fetch = mockFetch(context);

  for (const fail of [
    async () => {
      throw new Error('Offline');
    },
    async () => new Response('Unavailable', {status: 503}),
    async () => new Response('not json'),
  ]) {
    const service = new GasHistoryService('https://gas.example/api');
    fetch.mock.mockImplementation(fail);
    assert.equal(await service.getHistory(CHAIN_ID), undefined);

    fetch.mock.mockImplementation(async () => Response.json(history()));
    assert.deepEqual(await service.getHistory(CHAIN_ID), history());
  }
});
