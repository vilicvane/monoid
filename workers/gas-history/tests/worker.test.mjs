import assert from 'node:assert/strict';
import {test} from 'node:test';

import {serveHistory} from '../.bld/api.js';

const endpoint = 'https://example.test/api/gas-history/eip155:1';

test('the public endpoint only reads saved data and retains its JSON contract', async context => {
  const request = context.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected RPC');
  });
  const response = await serveHistory(new Request(endpoint), async () => []);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(body.chainId, 'eip155:1');
  assert.equal(body.windows['24h'].status, 'collecting');
  assert.equal(body.updatedAt, null);
  assert.equal(request.mock.callCount(), 0);
});

test('unsupported chains, methods and CORS preflight do not touch storage', async () => {
  const read = async () => {
    throw new Error('Unexpected storage read');
  };
  assert.equal(
    (
      await serveHistory(
        new Request(endpoint.replace('eip155:1', 'eip155:8453')),
        read,
      )
    ).status,
    404,
  );
  assert.equal(
    (await serveHistory(new Request(endpoint, {method: 'POST'}), read)).status,
    405,
  );
  assert.equal(
    (await serveHistory(new Request(endpoint, {method: 'OPTIONS'}), read))
      .status,
    204,
  );
  assert.equal(
    await (
      await serveHistory(
        new Request(endpoint, {method: 'HEAD'}),
        async () => [],
      )
    ).text(),
    '',
  );
});

test('unavailable persisted history returns 503 without RPC fallback', async () => {
  const response = await serveHistory(new Request(endpoint), async () => {
    throw new Error('storage unavailable');
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
