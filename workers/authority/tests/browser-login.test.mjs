import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateKeyPair} from 'jose';
import {setup, base, redirectUri} from './login-fixture.mjs';
import {randomToken, tokenHash} from '../.bld/encoding.js';

test('flow cookie, origin, exact redirect, app PKCE and one-use grant are bound together', async t => {
  const f = setup(t),
    flow = await f.begin();
  assert.equal(
    (await f.call('/auth/login/context?flow=' + flow.flow)).status,
    400,
  );
  assert.equal(
    (
      await f.call('/auth/login/google', {flow: flow.flow}, undefined, {
        ...flow.headers,
        Origin: 'https://evil.test',
      })
    ).status,
    403,
  );
  const attempt = await f.oauth(flow);
  assert.equal(attempt.url.searchParams.get('scope'), 'openid email profile');
  assert.equal(attempt.url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal((await f.call(attempt.callback)).status, 400);
  assert.equal(
    (await f.call(attempt.callback, undefined, undefined, flow.headers)).status,
    303,
  );
  assert.equal(
    (await f.call(attempt.callback, undefined, undefined, flow.headers)).status,
    400,
  );
  const grant = await f.complete(flow);
  assert.equal(
    (await f.call('/auth/login/token', {...grant, codeVerifier: randomToken()}))
      .status,
    400,
  );
  assert.equal(
    (
      await f.call('/auth/login/token', {
        ...grant,
        redirectUri: 'app.monoid://wrong',
      })
    ).status,
    400,
  );
  assert.equal((await f.call('/auth/login/token', grant)).status, 200);
  assert.equal((await f.call('/auth/login/token', grant)).status, 400);
});

for (const [name, claims, check] of [
  ['audience', {aud: 'other-client'}, 'audience'],
  ['issuer', {iss: 'https://evil.test'}, 'issuer'],
  ['expiry', {exp: 1}, 'expiry'],
  ['nonce', {nonce: 'wrong'}, 'nonce'],
  ['missing nonce', {nonce: undefined}, 'nonce'],
  ['missing expiry', {exp: undefined}, 'expiry'],
  ['authorized party', {azp: 'other-client'}, 'audience'],
  ['subject', {sub: ''}, 'claims'],
  ['issued-at', {iat: 9999999999}, 'claims'],
  [
    'multiple audiences without authorized party',
    {aud: ['google-client', 'other-client']},
    'audience',
  ],
])
  test(`Google rejects invalid ${name}`, async t => {
    const warn = t.mock.method(console, 'warn', () => {});
    const f = setup(t),
      flow = await f.begin(),
      attempt = await f.oauth(flow);
    f.upstream.claims = claims;
    assert.equal(
      (await f.call(attempt.callback, undefined, undefined, flow.headers))
        .status,
      303,
    );
    const context = await (
      await f.call(
        '/auth/login/context?flow=' + flow.flow,
        undefined,
        undefined,
        flow.headers,
      )
    ).json();
    assert.equal(context.account, null);
    assert.equal(context.error, 'invalid_google_identity');
    assert.deepEqual(
      warn.mock.calls.map(call => call.arguments),
      [['[oidc] ' + JSON.stringify({provider: 'google', check})]],
    );
    assert.equal(
      (
        await f.call(
          '/auth/login/complete',
          {flow: flow.flow},
          undefined,
          flow.headers,
        )
      ).status,
      400,
    );
  });

test('Google verifies the JWKS signature, not just token claims', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const f = setup(t),
    flow = await f.begin(),
    attempt = await f.oauth(flow);
  f.upstream.signingKey = (await generateKeyPair('RS256')).privateKey;
  await f.call(attempt.callback, undefined, undefined, flow.headers);
  const context = await (
    await f.call(
      '/auth/login/context?flow=' + flow.flow,
      undefined,
      undefined,
      flow.headers,
    )
  ).json();
  assert.equal(context.account, null);
  assert.equal(context.error, 'invalid_google_identity');
  assert.deepEqual(
    warn.mock.calls.map(call => call.arguments),
    [['[oidc] {"provider":"google","check":"signature"}']],
  );
});

for (const [claims, name] of [
  [{email_verified: false}, 'Alice'],
  [{email_verified: false, name: ''}, 'Google account'],
  [{email: '', name: ''}, 'Google account'],
])
  test(`unverified or missing Google email displays ${name}`, async t => {
    const f = setup(t);
    f.upstream.claims = claims;
    const result = await f.login();
    assert.deepEqual(result.account, {
      source: 'google',
      id: 'google-sub-123',
      displayName: name,
    });
  });

test('OAuth rejects state, cross-provider callback and upstream PKCE mismatch', async t => {
  const f = setup(t),
    flow = await f.begin(),
    attempt = await f.oauth(flow);
  assert.equal(
    (
      await f.call(
        '/auth/google/callback?state=' + randomToken() + '&code=fixture-code',
        undefined,
        undefined,
        flow.headers,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call(
        attempt.callback.replace('/google/', '/github/'),
        undefined,
        undefined,
        flow.headers,
      )
    ).status,
    400,
  );
  const key =
    'login-oauth:' + (await tokenHash(attempt.url.searchParams.get('state')));
  const saved = await f.stub.get(key),
    value = JSON.parse(await f.stub.openSession(saved));
  value.verifier = randomToken();
  await f.stub.replace(
    key,
    saved,
    await f.stub.sealSession(JSON.stringify(value)),
  );
  await f.call(attempt.callback, undefined, undefined, flow.headers);
  const context = await (
    await f.call(
      '/auth/login/context?flow=' + flow.flow,
      undefined,
      undefined,
      flow.headers,
    )
  ).json();
  assert.equal(context.account, null);
  assert.equal(context.error, 'google_authorization_failed');
});

test('OAuth denial returns to choices; reset and cancellation invalidate late provider results', async t => {
  const f = setup(t),
    flow = await f.begin();
  let attempt = await f.oauth(flow);
  await f.call(
    attempt.callback.replace('code=fixture-code', 'error=access_denied'),
    undefined,
    undefined,
    flow.headers,
  );
  assert.equal(
    (
      await (
        await f.call(
          '/auth/login/context?flow=' + flow.flow,
          undefined,
          undefined,
          flow.headers,
        )
      ).json()
    ).error,
    'sign_in_cancelled',
  );
  attempt = await f.oauth(flow);
  await f.call('/auth/login/reset', {flow: flow.flow}, undefined, flow.headers);
  assert.equal(
    (await f.call(attempt.callback, undefined, undefined, flow.headers)).status,
    400,
  );
  attempt = await f.oauth(flow);
  let release, started;
  const waiting = new Promise(resolve => {
    started = resolve;
  });
  f.upstream.beforeToken = () => {
    started();
    return new Promise(resolve => {
      release = resolve;
    });
  };
  const pending = f.call(attempt.callback, undefined, undefined, flow.headers);
  await waiting;
  const cancel = await f.call(
    '/auth/login/cancel',
    {flow: flow.flow},
    undefined,
    flow.headers,
  );
  assert.equal(cancel.status, 200);
  assert.equal(
    new URL((await cancel.json()).redirectUrl).searchParams.get('error'),
    'access_denied',
  );
  release();
  assert.equal((await pending).status, 400);
});

test('completion accepts only the verified flow identity and racing completions issue one code', async t => {
  const f = setup(t),
    flow = await f.begin();
  assert.equal(
    (
      await f.call(
        '/auth/login/complete',
        {flow: flow.flow},
        undefined,
        flow.headers,
      )
    ).status,
    400,
  );
  const attempt = await f.oauth(flow, 'github');
  await f.call(attempt.callback, undefined, undefined, flow.headers);
  assert.equal(
    (
      await f.call(
        '/auth/login/complete',
        {flow: flow.flow, account: {source: 'google', id: 'attacker'}},
        undefined,
        flow.headers,
      )
    ).status,
    400,
  );
  const results = await Promise.all(
    [1, 2].map(() =>
      f.call(
        '/auth/login/complete',
        {flow: flow.flow},
        undefined,
        flow.headers,
      ),
    ),
  );
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
});

test('expired browser flows and expired app grants fail closed', async t => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const f = setup(t),
    flow = await f.begin(),
    attempt = await f.oauth(flow);
  await f.call(attempt.callback, undefined, undefined, flow.headers);
  const grant = await f.complete(flow);
  now += 60000;
  assert.equal((await f.call('/auth/login/token', grant)).status, 400);
  const next = await f.begin();
  now += 10 * 60000;
  assert.equal(
    (
      await f.call(
        '/auth/login/context?flow=' + next.flow,
        undefined,
        undefined,
        next.headers,
      )
    ).status,
    400,
  );
});

test('invalid app redirect and weak PKCE/state never create a browser flow', async t => {
  const f = setup(t);
  for (const input of [
    {redirectUri: 'https://evil.test'},
    {codeChallengeMethod: 'plain'},
    {codeChallenge: 'short'},
    {state: 'bad'},
  ])
    assert.equal(
      (
        await f.call('/auth/login/start', {
          redirectUri,
          state: randomToken(),
          codeChallenge: randomToken(),
          codeChallengeMethod: 'S256',
          ...input,
        })
      ).status,
      400,
    );
});
