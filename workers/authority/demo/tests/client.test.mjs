import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AuthorityClient} from '../src/client.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return {promise, resolve};
}

test('browser fetch keeps its global receiver when called from the client', async t => {
  t.mock.method(globalThis, 'fetch', async function () {
    assert.equal(this, globalThis);
    return Response.json({ok: true});
  });
  const client = new AuthorityClient('https://authority.test');
  assert.deepEqual(await client.request('/v1/metadata'), {ok: true});
});

test('logout during login revokes late session without restoring it', async () => {
  const pending = deferred();
  const revoked = [];
  const client = new AuthorityClient(
    'https://authority.test',
    async (url, init) => {
      if (url.endsWith('/auth/reown')) return pending.promise;
      revoked.push(init.headers.Authorization);
      return new Response(null, {status: 204});
    },
  );
  const login = client.login('provider-token');
  await client.logout();
  pending.resolve(Response.json({accessToken: 'late-session'}));
  assert.equal(await login, undefined);
  assert.equal(client.token, undefined);
  assert.deepEqual(revoked, ['Bearer late-session']);
});

test('newer identity wins when provider exchanges complete out of order', async () => {
  const first = deferred(),
    second = deferred(),
    revoked = [];
  const client = new AuthorityClient(
    'https://authority.test',
    async (url, init) => {
      if (url.endsWith('/auth/reown'))
        return JSON.parse(init.body).token === 'first'
          ? first.promise
          : second.promise;
      revoked.push(init.headers.Authorization);
      return new Response(null, {status: 204});
    },
  );
  const old = client.login('first');
  const current = client.login('second');
  second.resolve(Response.json({accessToken: 'current'}));
  await current;
  first.resolve(Response.json({accessToken: 'old'}));
  await old;
  assert.equal(client.token, 'current');
  assert.deepEqual(revoked, ['Bearer old']);
});

test('GitHub result arriving after logout cannot resurrect the connection', async () => {
  const pending = deferred(),
    revoked = [];
  const client = new AuthorityClient(
    'https://authority.test',
    async (url, init) => {
      if (url.endsWith('/auth/token')) return pending.promise;
      revoked.push(init.headers.Authorization);
      return new Response(null, {status: 204});
    },
  );
  client.token = 'original';
  const linked = client.connectGitHub('code', 'verifier');
  await client.logout();
  pending.resolve(Response.json({accessToken: 'linked'}));
  assert.equal(await linked, undefined);
  assert.equal(client.token, undefined);
  assert.deepEqual(revoked, ['Bearer original', 'Bearer linked']);
});
