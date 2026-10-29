import assert from 'node:assert/strict';
import {generateKeyPair, exportJWK, SignJWT} from 'jose';
import {privateKeyToAccount} from 'viem/accounts';
import {createHandler} from '../.bld/api.js';
import {randomToken, tokenHash} from '../.bld/encoding.js';
import {cryptoState, database} from './helpers.mjs';

const keys = await generateKeyPair('RS256');
const jwk = {
  ...(await exportJWK(keys.publicKey)),
  kid: 'fixture',
  alg: 'RS256',
  use: 'sig',
};
export const signer = privateKeyToAccount('0x' + '11'.repeat(32));
export const base = 'https://authority.monoid.app';
export const redirectUri = 'app.monoid://authority/callback';

export function providerFixture() {
  const upstream = {
    role: 'admin',
    membership: 'active',
    claims: {},
    rpcValid: true,
    calls: [],
    rpcCalls: [],
  };
  const fetcher = async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    upstream.calls.push(url.href);
    if (
      url.hostname === 'oauth2.googleapis.com' ||
      url.pathname === '/login/oauth/access_token'
    ) {
      const form = new URLSearchParams(await request.text());
      assert.equal(form.get('code'), 'fixture-code');
      assert.equal(form.get('code_verifier')?.length, 43);
      if (
        (await tokenHash(form.get('code_verifier'))) !== upstream.challenge ||
        upstream.rejectCode
      )
        return Response.json({error: 'invalid_grant'}, {status: 400});
      await upstream.beforeToken?.();
      if (upstream.tokenResponse) return upstream.tokenResponse(form);
      if (url.hostname === 'oauth2.googleapis.com') {
        assert.equal(form.get('redirect_uri'), base + '/auth/google/callback');
        assert.equal(form.get('client_id'), 'google-client');
        assert.equal(form.get('client_secret'), 'fixture-google-secret');
        const now = Math.floor(Date.now() / 1000);
        return Response.json({
          id_token: await new SignJWT({
            iss: 'https://accounts.google.com',
            aud: 'google-client',
            sub: 'google-sub-123',
            iat: now,
            exp: now + 3600,
            nonce: upstream.nonce,
            email: 'alice@example.com',
            email_verified: true,
            name: 'Alice',
            ...upstream.claims,
          })
            .setProtectedHeader({alg: 'RS256', kid: 'fixture'})
            .sign(upstream.signingKey ?? keys.privateKey),
        });
      }
      assert.equal(form.get('client_secret'), 'fixture-github-secret');
      assert.equal(form.get('redirect_uri'), base + '/auth/github/callback');
      return Response.json({
        access_token: 'fixture-github-token',
        token_type: 'bearer',
        scope: 'read:org',
      });
    }
    if (url.href === 'https://www.googleapis.com/oauth2/v3/certs')
      return Response.json({keys: [jwk]});
    if (url.hostname === 'api.github.com') {
      assert.equal(
        request.headers.get('Authorization'),
        'Bearer fixture-github-token',
      );
      if (upstream.githubStatus)
        return new Response(null, {status: upstream.githubStatus});
      if (url.pathname === '/user')
        return Response.json({
          id: upstream.githubId ?? 7,
          login: 'octocat',
          type: 'User',
        });
      if (url.pathname === '/user/memberships/orgs')
        return Response.json([
          {
            state: upstream.membership,
            role: upstream.role,
            organization: {id: 42, login: 'team'},
          },
        ]);
    }
    if (url.hostname === 'rpc.fixture') {
      const rpc = await request.json();
      upstream.rpcCalls.push(rpc);
      await upstream.beforeRpc?.();
      if (upstream.rpcError) return new Response(null, {status: 503});
      assert.ok(['eth_chainId', 'eth_call'].includes(rpc.method));
      return Response.json({
        jsonrpc: '2.0',
        id: rpc.id,
        result:
          rpc.method === 'eth_chainId'
            ? (upstream.chainId ?? '0x1')
            : upstream.rpcValid
              ? '0x01'
              : '0x00',
      });
    }
    throw new Error('Unexpected provider: ' + url.href);
  };
  return {upstream, fetcher};
}

export function environment(stub) {
  return {
    AUTHORITY_URL: base,
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
    GITHUB_CLIENT_ID: 'github-client',
    GITHUB_CLIENT_SECRET: 'fixture-github-secret',
    WALLETCONNECT_PROJECT_ID: 'fixture-project',
    ETHEREUM_RPC_URL: 'https://rpc.fixture',
    APP_ORIGINS: '[]',
    APP_REDIRECT_URIS: JSON.stringify([redirectUri]),
    AUTHORITY_STATE: {getByName: () => stub},
    REQUEST_LIMIT: {limit: async () => ({success: true})},
  };
}

export function client(call, upstream) {
  const begin = async () => {
    const verifier = randomToken(),
      state = randomToken();
    const response = await call('/auth/login/start', {
      redirectUri,
      state,
      codeChallenge: await tokenHash(verifier),
      codeChallengeMethod: 'S256',
    });
    assert.equal(response.status, 200);
    const start = await response.json();
    const authorized = await call(
      new URL(start.authorizationUrl).pathname +
        new URL(start.authorizationUrl).search,
    );
    assert.equal(authorized.status, 303);
    const flow = new URL(authorized.headers.get('Location')).searchParams.get(
      'flow',
    );
    const cookie = authorized.headers.get('Set-Cookie').split(';')[0];
    return {flow, verifier, state, headers: {Cookie: cookie, Origin: base}};
  };
  const oauth = async (flow, provider = 'google') => {
    const response = await call(
      '/auth/login/' + provider,
      {flow: flow.flow},
      undefined,
      flow.headers,
    );
    assert.equal(response.status, 200);
    const url = new URL((await response.json()).authorizationUrl);
    upstream.nonce = url.searchParams.get('nonce');
    upstream.challenge = url.searchParams.get('code_challenge');
    return {
      url,
      callback: `/auth/${provider}/callback?state=${url.searchParams.get('state')}&code=fixture-code`,
    };
  };
  const complete = async flow => {
    const response = await call(
      '/auth/login/complete',
      {flow: flow.flow},
      undefined,
      flow.headers,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const url = new URL((await response.json()).redirectUrl);
    assert.equal(url.searchParams.get('state'), flow.state);
    return {
      code: url.searchParams.get('code'),
      codeVerifier: flow.verifier,
      redirectUri,
    };
  };
  const login = async (provider = 'google') => {
    const flow = await begin();
    const attempt = await oauth(flow, provider);
    assert.equal(
      (await call(attempt.callback, undefined, undefined, flow.headers)).status,
      303,
    );
    const grant = await complete(flow);
    const response = await call('/auth/login/token', grant);
    assert.equal(response.status, 200);
    return response.json();
  };
  return {begin, oauth, complete, login};
}

export function setup(context) {
  const store = database(context);
  const stub = {
    ...cryptoState(),
    put: (...args) => store.put(...args),
    get: key => store.get(key, Date.now()),
    take: (key, proof) => store.take(key, proof, Date.now()),
    takeMatch: (key, proof, value) =>
      store.takeMatch(key, proof, value, Date.now()),
    replace: (key, expected, value) =>
      store.replace(key, expected, value, Date.now()),
    touchSession: (key, cap) => store.touchSession(key, cap, Date.now()),
    remove: key => store.remove(key),
    group: (...args) => store.group(...args),
    groups: (...args) => store.groups(...args),
    namespace: (...args) => store.namespace(...args),
    namespaces: items =>
      items.map(item => store.namespace(item, item.displayName)),
  };
  const env = environment(stub);
  const {upstream, fetcher} = providerFixture();
  const handler = createHandler(fetcher);
  const call = (path, body, token, headers = {}) =>
    handler(
      new Request(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
          ...(token ? {Authorization: `Bearer ${token}`} : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );
  return {store, stub, env, upstream, call, ...client(call, upstream)};
}
