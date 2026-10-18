import assert from 'node:assert/strict';
import {test} from 'node:test';

const {createSolanaRPC} = await import('../.bld/app/@lib/solana-rpc.js');

const chainId = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const genesisHash = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

function result(init, value) {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: JSON.parse(init.body).id,
      result: value,
    }),
  );
}

test('verifies the network before the first RPC request and reuses verification', async () => {
  const calls = [];
  const rpc = createSolanaRPC(chainId, 'project-id', async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    assert.equal(url.origin, 'https://rpc.walletconnect.org');
    assert.equal(url.searchParams.get('chainId'), chainId);
    assert.equal(url.searchParams.get('projectId'), 'project-id');
    return result(
      init,
      body.method === 'getGenesisHash' ? genesisHash : {value: []},
    );
  });

  assert.deepEqual(
    await rpc('getMultipleAccounts', [[], {encoding: 'base64'}]),
    {value: []},
  );
  await rpc('getMultipleAccounts', [[]]);
  assert.deepEqual(
    calls.map(call => call.method),
    ['getGenesisHash', 'getMultipleAccounts', 'getMultipleAccounts'],
  );
  assert.equal(new Set(calls.map(call => call.id)).size, 3);
});

test('rejects mismatched networks before reading accounts and can retry verification', async () => {
  const methods = [];
  let correctNetwork = false;
  const rpc = createSolanaRPC(chainId, 'project-id', async (_url, init) => {
    const {method} = JSON.parse(init.body);
    methods.push(method);
    return result(
      init,
      method === 'getGenesisHash'
        ? correctNetwork
          ? genesisHash
          : 'other-genesis'
        : null,
    );
  });

  await assert.rejects(rpc('getMultipleAccounts', [[]]), /different network/);
  assert.deepEqual(methods, ['getGenesisHash']);
  correctNetwork = true;
  assert.equal(await rpc('getMultipleAccounts', [[]]), null);
  assert.deepEqual(methods, [
    'getGenesisHash',
    'getGenesisHash',
    'getMultipleAccounts',
  ]);
});

test('preserves RPC error messages and reports HTTP and malformed responses', async () => {
  for (const [response, expected] of [
    [
      new Response(
        JSON.stringify({error: {code: 403, message: 'Access forbidden'}}),
        {status: 403},
      ),
      /Access forbidden/,
    ],
    [new Response('gateway unavailable', {status: 502}), /HTTP 502/],
    [new Response('not json'), /Invalid Solana RPC response/],
    [
      new Response(
        JSON.stringify({jsonrpc: '2.0', id: 999, result: genesisHash}),
      ),
      /Invalid Solana RPC response/,
    ],
  ]) {
    const rpc = createSolanaRPC(chainId, 'project-id', async () => response);
    await assert.rejects(rpc('getMultipleAccounts', [[]]), expected);
  }
});

test('cancels before starting and during a network request', async () => {
  const controller = new AbortController();
  controller.abort();
  const rpc = createSolanaRPC(
    chainId,
    'project-id',
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(init.signal.reason),
          {once: true},
        );
      }),
  );
  await assert.rejects(rpc('getMultipleAccounts', [[]], controller.signal), {
    name: 'AbortError',
  });

  const pendingController = new AbortController();
  const pending = rpc('getMultipleAccounts', [[]], pendingController.signal);
  pendingController.abort();
  await assert.rejects(pending, {name: 'AbortError'});
});

test('bounds each HTTP request to fifteen seconds', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const rpc = createSolanaRPC(
    chainId,
    'project-id',
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(init.signal.reason),
          {once: true},
        );
      }),
  );
  const pending = rpc('getMultipleAccounts', [[]]);
  t.mock.timers.tick(15_000);
  await assert.rejects(pending, /timed out/);
});
