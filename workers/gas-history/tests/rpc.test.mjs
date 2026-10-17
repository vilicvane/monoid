import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  BlockReader,
  RpcBudgetExhausted,
  RpcRateLimited,
  findBlockAtOrBefore,
} from '../.bld/rpc.js';

function response(number, timestamp) {
  return Response.json({
    result: {
      number: `0x${number.toString(16)}`,
      timestamp: `0x${timestamp.toString(16)}`,
      baseFeePerGas: '0x20000000000001',
    },
  });
}

test('historical lookup proves the boundary even across missed slots and long block gaps', async context => {
  const times = Array.from(
    {length: 2000},
    (_, i) =>
      1700000000 + i * 12 + Math.floor(i / 10) * 12 + (i >= 1000 ? 600 : 0),
  );
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    const [number] = JSON.parse(options.body).params;
    const index =
      number === 'latest' ? times.length - 1 : Number(BigInt(number));
    return response(index, times[index]);
  });

  for (const target of [
    times[0],
    times[217] + 11,
    times[999] + 300,
    times[1567],
  ]) {
    const reader = new BlockReader('https://rpc.example.test');
    const block = await findBlockAtOrBefore(
      reader,
      target,
      await reader.get('latest'),
    );
    const expected = times.findLastIndex(time => time <= target);
    assert.equal(block.number, BigInt(expected));
    assert.equal(block.baseFeePerGas, '9007199254740993');
    assert.ok(reader.requests < 15);
  }
});

test('RPC requests are cached and bounded by count and elapsed time', async context => {
  let clock = 1800000000000;
  context.mock.method(Date, 'now', () => clock);
  const request = context.mock.method(
    globalThis,
    'fetch',
    async (_url, options) => {
      const number = BigInt(JSON.parse(options.body).params[0]);
      return response(number, 1700000000 + Number(number) * 12);
    },
  );
  const reader = new BlockReader('https://rpc.example.test');
  await reader.get(1n);
  await reader.get(1n);
  assert.equal(request.mock.callCount(), 1);
  for (let number = 2n; number <= 40n; number++) await reader.get(number);
  await assert.rejects(reader.get(41n), RpcBudgetExhausted);
  assert.equal(request.mock.callCount(), 40);

  const expired = new BlockReader('https://rpc.example.test');
  clock += 90000;
  await assert.rejects(expired.get(1n), RpcBudgetExhausted);
  assert.equal(request.mock.callCount(), 40);
});

test('RPC pacing survives a new batch and cached blocks consume no interval', async context => {
  context.mock.timers.enable({
    apis: ['Date', 'setTimeout'],
    now: 1800000000000,
  });
  const requestTimes = [];
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    requestTimes.push(Date.now());
    const number = BigInt(JSON.parse(options.body).params[0]);
    return response(number, 1700000000 + Number(number) * 12);
  });

  const firstBatch = new BlockReader('https://rpc.example.test', {
    requestIntervalMs: 200,
  });
  await firstBatch.get(1n);
  const second = firstBatch.get(2n);
  context.mock.timers.tick(199);
  assert.deepEqual(requestTimes, [1800000000000]);
  context.mock.timers.tick(1);
  await second;
  assert.equal(firstBatch.nextRequestAt, 1800000000400);

  await firstBatch.get(1n);
  assert.equal(firstBatch.requests, 2);
  assert.equal(firstBatch.nextRequestAt, 1800000000400);

  const nextBatch = new BlockReader('https://rpc.example.test', {
    requestIntervalMs: 200,
    nextRequestAt: firstBatch.nextRequestAt,
  });
  const third = nextBatch.get(3n);
  context.mock.timers.tick(199);
  assert.equal(requestTimes.length, 2);
  context.mock.timers.tick(1);
  await third;
  assert.deepEqual(requestTimes, [1800000000000, 1800000000200, 1800000000400]);
  assert.equal(nextBatch.nextRequestAt, 1800000000600);
});

test('a pacing delay cannot start an RPC after the batch deadline', async context => {
  context.mock.timers.enable({
    apis: ['Date', 'setTimeout'],
    now: 1800000000000,
  });
  const request = context.mock.method(globalThis, 'fetch', async () =>
    response(1, 1700000000),
  );
  const reader = new BlockReader('https://rpc.example.test', {
    requestIntervalMs: 200,
    nextRequestAt: Date.now() + 90000,
  });

  const pending = reader.get(1n);
  context.mock.timers.tick(90000);
  await assert.rejects(pending, RpcBudgetExhausted);
  assert.equal(request.mock.callCount(), 0);
  assert.equal(reader.requests, 0);
});

test('HTTP 429 exposes Retry-After and releases the body without retrying', async context => {
  const now = 1800000000000;
  const cases = [
    ['3', now + 3000],
    ['1.5', now + 1500],
    [new Date(now + 15000).toUTCString(), now + 15000],
    [new Date(now - 15000).toUTCString(), now],
    ['0', now],
    [null, now + 5000],
    ['invalid', now + 5000],
    ['-1', now + 5000],
    ['9'.repeat(400), now + 5000],
  ];

  for (const [header, expected] of cases) {
    await context.test(`Retry-After: ${header}`, async subcontext => {
      subcontext.mock.method(Date, 'now', () => now);
      let cancelled = false;
      const request = subcontext.mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            {
              status: 429,
              headers: header === null ? {} : {'Retry-After': header},
            },
          ),
      );
      const reader = new BlockReader('https://rpc.example.test', {
        requestIntervalMs: 200,
      });

      await assert.rejects(reader.get(1n), error => {
        assert.ok(error instanceof RpcRateLimited);
        assert.equal(error.retryAt, expected);
        return true;
      });
      assert.equal(cancelled, true);
      assert.equal(request.mock.callCount(), 1);
      assert.equal(reader.requests, 1);
      assert.equal(reader.nextRequestAt, now + 200);
    });
  }
});

test('other HTTP failures also release their response body', async context => {
  let cancelled = false;
  context.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        {status: 503},
      ),
  );
  const reader = new BlockReader('https://rpc.example.test');
  await assert.rejects(reader.get(1n), /HTTP 503/);
  assert.equal(cancelled, true);
});

test('a provider returning the latest block for a historical request is rejected', async context => {
  context.mock.method(globalThis, 'fetch', async () =>
    response(100, 1800000000),
  );
  const reader = new BlockReader('https://rpc.example.test');
  await assert.rejects(reader.get(99n), /wrong block number/);
});
