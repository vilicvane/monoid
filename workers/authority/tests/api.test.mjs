import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createECDH} from 'node:crypto';
import {setup} from './login-fixture.mjs';
import {tokenHash} from '../.bld/encoding.js';

test('token/me account is the provider-native personal namespace; no provider revalidation', async t => {
  const f = setup(t),
    session = await f.login();
  assert.deepEqual(session.account, {
    source: 'google',
    id: 'google-sub-123',
    displayName: 'alice@example.com',
  });
  assert.ok(session.expiresIn <= 300 && session.expiresIn > 0);
  const before = f.upstream.calls.length;
  assert.deepEqual(
    await (await f.call('/v1/me', undefined, session.accessToken)).json(),
    {account: session.account},
  );
  assert.deepEqual(
    (
      await (
        await f.call('/v1/namespaces', undefined, session.accessToken)
      ).json()
    ).namespaces,
    [session.account],
  );
  assert.equal(f.upstream.calls.length, before);
});

test('GitHub personal owner and only active organization Owners; membership is checked for listing and issuance', async t => {
  const f = setup(t),
    session = await f.login('github');
  assert.deepEqual(session.account, {
    source: 'github-user',
    id: '7',
    displayName: 'octocat',
  });
  const owner = {source: 'github-organization', id: '42'};
  let namespaces = await (
    await f.call('/v1/namespaces', undefined, session.accessToken)
  ).json();
  assert.equal(namespaces.namespaces.length, 2);
  const key = createECDH('prime256v1');
  key.generateKeys();
  const bundle = {
    owner,
    groupName: 'Team',
    allowPeerExtension: false,
    recipientPublicKey: key.getPublicKey().toString('base64url'),
  };
  assert.equal(
    (await f.call('/v1/bundle', bundle, session.accessToken)).status,
    200,
  );
  for (const changes of [
    {role: 'member'},
    {role: 'admin', membership: 'pending'},
  ]) {
    Object.assign(f.upstream, changes);
    assert.equal(
      (await f.call('/v1/groups/list', {owner}, session.accessToken)).status,
      403,
    );
    assert.equal(
      (await f.call('/v1/bundle', bundle, session.accessToken)).status,
      403,
    );
    namespaces = await (
      await f.call('/v1/namespaces', undefined, session.accessToken)
    ).json();
    assert.equal(namespaces.namespaces.length, 1);
  }
  f.upstream.githubStatus = 401;
  assert.equal(
    (await f.call('/v1/groups/list', {owner}, session.accessToken)).status,
    401,
  );
  assert.equal(
    (await f.call('/v1/me', undefined, session.accessToken)).status,
    200,
  );
});

test('personal issuance isolates source/id, fixes policy and retains editable namespace labels', async t => {
  const f = setup(t),
    session = await f.login(),
    owner = {source: session.account.source, id: session.account.id};
  const key = createECDH('prime256v1');
  key.generateKeys();
  const bundle = {
    owner,
    groupName: 'Family',
    allowPeerExtension: false,
    recipientPublicKey: key.getPublicKey().toString('base64url'),
  };
  assert.equal(
    (await f.call('/v1/bundle', bundle, session.accessToken)).status,
    200,
  );
  assert.equal(
    (
      await f.call(
        '/v1/bundle',
        {...bundle, allowPeerExtension: true},
        session.accessToken,
      )
    ).status,
    409,
  );
  for (const other of [
    {source: 'github-user', id: owner.id},
    {source: 'google', id: 'other'},
    {source: 'wallet', id: 'eip155:0x' + 'ab'.repeat(20)},
  ])
    assert.equal(
      (await f.call('/v1/groups/list', {owner: other}, session.accessToken))
        .status,
      403,
    );
  assert.equal(
    (
      await f.call(
        '/v1/groups/list',
        {owner: {source: 'unsupported', id: '1'}},
        session.accessToken,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call(
        '/v1/namespaces/name',
        {owner, displayName: 'My account'},
        session.accessToken,
      )
    ).status,
    200,
  );
  const result = await (
    await f.call('/v1/groups/list', {owner}, session.accessToken)
  ).json();
  assert.equal(result.owner.displayName, 'My account');
  assert.equal(result.groups[0].name, 'Family');
});

test('successful authentication slides idle expiry; public requests and logout cannot revive it', async t => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const f = setup(t),
    session = await f.login();
  assert.equal(session.expiresIn, 300);
  now += 4 * 60000;
  assert.equal(
    (await f.call('/v1/me', undefined, session.accessToken)).status,
    200,
  );
  now += 3 * 60000;
  assert.equal(
    (await f.call('/v1/namespaces', undefined, session.accessToken)).status,
    200,
  );
  now += 4 * 60000;
  await f.call('/v1/metadata');
  now += 60000;
  assert.equal(
    (await f.call('/v1/me', undefined, session.accessToken)).status,
    401,
  );
  const next = await f.login();
  await f.call('/auth/logout', {}, next.accessToken);
  assert.equal(
    (await f.call('/v1/me', undefined, next.accessToken)).status,
    401,
  );
});

for (const minutes of [2, 7, 15])
  test(`absolute/provider cap wins at ${minutes} minutes`, async t => {
    let now = 1800000000000;
    t.mock.method(Date, 'now', () => now);
    const f = setup(t);
    f.upstream.claims.exp = Math.floor(now / 1000) + minutes * 60;
    const session = await f.login();
    assert.equal(session.expiresIn, Math.min(300, minutes * 60));
    const start = now;
    for (let i = 1; i < minutes; i++) {
      now = start + i * 60000;
      assert.equal(
        (await f.call('/v1/me', undefined, session.accessToken)).status,
        200,
      );
    }
    now = start + minutes * 60000;
    assert.equal(
      (await f.call('/v1/me', undefined, session.accessToken)).status,
      401,
    );
  });

test('pre-contract sessions fail closed, and public endpoints keep CORS/rate/body bounds', async t => {
  const f = setup(t),
    session = await f.login();
  const key = 'session:' + (await tokenHash(session.accessToken)),
    saved = await f.stub.get(key),
    value = JSON.parse(await f.stub.openSession(saved));
  delete value.account.source;
  await f.stub.replace(
    key,
    saved,
    await f.stub.sealSession(JSON.stringify(value)),
  );
  assert.equal(
    (await f.call('/v1/me', undefined, session.accessToken)).status,
    401,
  );
  assert.equal(
    (
      await f.call('/v1/time', {
        challenge: Buffer.alloc(32).toString('base64url'),
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.call('/auth/login/start', {large: 'x'.repeat(5000)})).status,
    413,
  );
  assert.equal(
    (
      await f.call('/v1/metadata', undefined, undefined, {
        Origin: 'https://evil.test',
      })
    ).status,
    403,
  );
  f.env.REQUEST_LIMIT.limit = async () => ({success: false});
  const limited = await f.call('/v1/metadata');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '60');
});
