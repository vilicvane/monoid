import assert from 'node:assert/strict';
import {test} from 'node:test';

import worker, {collectSample} from '../.bld/worker.js';

const now = 1800000000;
const endpoint = 'https://example.test/api/gas-history/eip155:1';

function environment() {
  const values = new Map();
  return {
    values,
    env: {
      ETHEREUM_RPC_URL: 'https://rpc.example.test',
      GAS_HISTORY: {
        async get(key) {
          return values.has(key) ? JSON.parse(values.get(key)) : null;
        },
        async put(key, value) {
          values.set(key, value);
        },
      },
    },
  };
}

function rpcBlock(timestamp = now, number = 1000) {
  return Response.json({
    jsonrpc: '2.0',
    id: 1,
    result: {
      number: `0x${number.toString(16)}`,
      timestamp: `0x${timestamp.toString(16)}`,
      baseFeePerGas: '0x1',
    },
  });
}

test('collects into the scheduled bucket despite block timestamps around its boundary', async context => {
  const {env, values} = environment();
  let clock = now;
  context.mock.method(Date, 'now', () => clock * 1000);
  const request = context.mock.method(globalThis, 'fetch', async () =>
    rpcBlock(clock - 12, clock),
  );

  await collectSample(env, now * 1000);
  clock = now + 300;
  await collectSample(env, clock * 1000);
  const samples = JSON.parse(values.get('samples:eip155:1'));
  assert.deepEqual(
    samples.map(sample => sample.timestamp),
    [now, now + 300],
  );
  assert.equal(samples[0].baseFeePerGas, '1');
  assert.deepEqual(JSON.parse(request.mock.calls[0].arguments[1].body).params, [
    'latest',
    false,
  ]);
});

test('repeating the same block does not invent fresh samples', async context => {
  const {env, values} = environment();
  let clock = now;
  context.mock.method(Date, 'now', () => clock * 1000);
  context.mock.method(globalThis, 'fetch', async () => rpcBlock(now));

  await collectSample(env, now * 1000);
  clock += 300;
  await collectSample(env, clock * 1000);
  assert.equal(JSON.parse(values.get('samples:eip155:1')).length, 1);
});

test('stale, future, invalid and failed RPC samples leave saved history intact', async context => {
  const {env, values} = environment();
  const saved = JSON.stringify([
    {timestamp: now - 300, blockNumber: '999', baseFeePerGas: '1'},
  ]);
  values.set('samples:eip155:1', saved);
  context.mock.method(Date, 'now', () => now * 1000);
  let response;
  context.mock.method(globalThis, 'fetch', async () => response);

  for (response of [
    rpcBlock(now - 301),
    rpcBlock(now + 61),
    Response.json({result: null}),
    new Response(null, {status: 503}),
  ]) {
    await assert.rejects(collectSample(env, now * 1000));
    assert.equal(values.get('samples:eip155:1'), saved);
  }
});

test('late scheduled invocations cannot backfill an old slot with a current price', async context => {
  const {env} = environment();
  context.mock.method(Date, 'now', () => now * 1000);
  const request = context.mock.method(globalThis, 'fetch', async () =>
    rpcBlock(),
  );

  await assert.rejects(collectSample(env, (now - 300) * 1000));
  assert.equal(request.mock.callCount(), 0);
});

test('the public endpoint reads stored data and does not cause RPC work', async context => {
  const {env} = environment();
  const request = context.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected RPC');
  });
  const response = await worker.fetch(new Request(endpoint), env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(body.chainId, 'eip155:1');
  assert.equal(body.windows['24h'].status, 'collecting');
  assert.equal(body.updatedAt, null);
  assert.equal(request.mock.callCount(), 0);
});

test('unsupported chains, methods and CORS preflight have explicit responses', async () => {
  const {env} = environment();
  assert.equal(
    (
      await worker.fetch(
        new Request(endpoint.replace('eip155:1', 'eip155:8453')),
        env,
      )
    ).status,
    404,
  );
  assert.equal(
    (await worker.fetch(new Request(endpoint, {method: 'POST'}), env)).status,
    405,
  );
  assert.equal(
    (await worker.fetch(new Request(endpoint, {method: 'OPTIONS'}), env))
      .status,
    204,
  );
  assert.equal(
    await (
      await worker.fetch(new Request(endpoint, {method: 'HEAD'}), env)
    ).text(),
    '',
  );
});
