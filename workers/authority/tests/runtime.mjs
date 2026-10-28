import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {createECDH} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {tokenHash} from '../.bld/encoding.js';
import {
  base,
  client,
  environment,
  providerFixture,
  signer,
} from './login-fixture.mjs';

async function removePersistence(root) {
  assert.equal(dirname(root), tmpdir());
  assert.ok(basename(root).startsWith('monoid-authority-runtime-'));
  await rm(root, {recursive: true, force: true});
}
function options(root, fixture, script, assets = false) {
  const {AUTHORITY_STATE, REQUEST_LIMIT, ...bindings} = environment(null);
  return {
    ...convertV4MiniflareOptions({
      name: 'authority-test',
      modules: true,
      ...(script ? {script} : {scriptPath: '.wrangler/test/worker.js'}),
      compatibilityDate: '2026-10-19',
      durableObjects: {
        AUTHORITY_STATE: {className: 'AuthorityState', useSQLite: true},
      },
      ratelimits: {
        REQUEST_LIMIT: {
          namespace_id: '1002',
          simple: {limit: 1000, period: 60},
        },
      },
      bindings,
      ...(assets
        ? {
            assets: {
              directory: 'web/dist',
              binding: 'ASSETS',
              run_worker_first: true,
              routerConfig: {has_user_worker: true},
              assetConfig: {html_handling: 'none', not_found_handling: 'none'},
            },
          }
        : {}),
      handleStructuredLogs: log => fixture.upstream.logs.push(log),
      outboundService: async request =>
        fixture.fetcher(request.url, {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: ['GET', 'HEAD'].includes(request.method)
            ? undefined
            : new Uint8Array(await request.arrayBuffer()),
        }),
    }),
    resourcePersistencePath: root,
  };
}
async function setup(t, assets = false) {
  const root = await mkdtemp(join(tmpdir(), 'monoid-authority-runtime-')),
    fixture = providerFixture();
  fixture.upstream.logs = [];
  let mf = new Miniflare(options(root, fixture, undefined, assets));
  t.after(async () => {
    await mf.dispose();
    await removePersistence(root);
  });
  const call = (path, body, token, headers = {}) =>
    mf.dispatchFetch(base + path, {
      redirect: 'manual',
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
        ...(token ? {Authorization: 'Bearer ' + token} : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    call,
    upstream: fixture.upstream,
    ...client(call, fixture.upstream),
    stub: async () =>
      (await mf.getDurableObjectNamespace('AUTHORITY_STATE')).getByName(
        'authority',
      ),
    restart: async () => {
      await mf.dispose();
      mf = new Miniflare(options(root, fixture, undefined, assets));
    },
  };
}

test('workerd serves built public HTML and preserves the separate login entry', async t => {
  const f = await setup(t, true);
  for (const [path, title] of [
    ['/', 'Monoid Authority'],
    ['/privacy', 'Privacy policy · Monoid Authority'],
    ['/terms', 'Terms of service · Monoid Authority'],
  ]) {
    const response = await f.call(path + '?flow=not-retained');
    assert.equal(
      response.status,
      200,
      JSON.stringify({
        body: await response.clone().text(),
        logs: f.upstream.logs,
      }),
    );
    assert.equal(response.headers.get('Location'), null);
    assert.match(response.headers.get('Content-Type'), /text\/html/);
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
    const html = await response.text();
    assert.ok(html.includes(`<title>${title}</title>`));
    assert.match(html, /href="\/privacy"/);
    assert.match(html, /href="\/terms"/);
    assert.doesNotMatch(html, /<script|<button|%BASE_URL%|not-retained/);
    const css = html.match(/href="(\/assets\/[^\"]+\.css)"/)[1];
    const style = await f.call(css);
    assert.equal(style.status, 200);
    assert.match(style.headers.get('Content-Type'), /text\/css/);
  }
  const login = await f.call('/login?flow=not-retained');
  assert.equal(login.status, 200);
  assert.equal(login.headers.get('Referrer-Policy'), 'origin');
  assert.equal(login.headers.get('Cache-Control'), 'no-store');
  const html = await login.text();
  assert.match(html, /<title>Sign in · Monoid<\/title>/);
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /<script type="module"/);
  assert.doesNotMatch(html, /not-retained|<h1>/);
  assert.equal((await f.call('/privacy', {})).status, 404);
  assert.equal((await f.call('/unknown')).status, 404);
});

for (const provider of ['google', 'github'])
  test(`workerd ${provider} OAuth, encrypted identity, PKCE and persistent owner/session`, async t => {
    const f = await setup(t),
      metadata = await (await f.call('/v1/metadata')).json();
    const flow = await f.begin(),
      attempt = await f.oauth(flow, provider);
    await f.restart();
    assert.equal(
      (await f.call(attempt.callback, undefined, undefined, flow.headers))
        .status,
      303,
    );
    const grant = await f.complete(flow),
      session = await (await f.call('/auth/login/token', grant)).json();
    assert.equal(
      session.account.source,
      provider === 'github' ? 'github-user' : 'google',
    );
    assert.equal((await f.call('/auth/login/token', grant)).status, 400);
    const stub = await f.stub(),
      key = 'session:' + (await tokenHash(session.accessToken)),
      sealed = await stub.get(key);
    assert.ok(!sealed.includes(session.account.displayName));
    const recipient = createECDH('prime256v1');
    recipient.generateKeys();
    const input = {
      owner: {source: session.account.source, id: session.account.id},
      groupName: 'Runtime',
      allowPeerExtension: false,
      recipientPublicKey: recipient.getPublicKey().toString('base64url'),
    };
    assert.equal(
      (await f.call('/v1/bundle', input, session.accessToken)).status,
      200,
    );
    await f.restart();
    assert.equal(
      (await (await f.call('/v1/metadata')).json()).publicKey,
      metadata.publicKey,
    );
    assert.deepEqual(
      await (await f.call('/v1/me', undefined, session.accessToken)).json(),
      {account: session.account},
    );
    assert.equal(
      (
        await (
          await f.call(
            '/v1/groups/list',
            {owner: input.owner},
            session.accessToken,
          )
        ).json()
      ).groups[0].name,
      'Runtime',
    );
    if (provider === 'github') {
      assert.equal(
        (
          await (
            await f.call('/v1/namespaces', undefined, session.accessToken)
          ).json()
        ).namespaces.length,
        2,
      );
      f.upstream.role = 'member';
      assert.equal(
        (
          await f.call(
            '/v1/groups/list',
            {owner: {source: 'github-organization', id: '42'}},
            session.accessToken,
          )
        ).status,
        403,
      );
    }
  });

test('workerd persists unnamed bundle policy and distinguishes start from an empty-name cursor', async t => {
  const f = await setup(t),
    session = await f.login();
  const owner = {source: session.account.source, id: session.account.id};
  const recipient = createECDH('prime256v1');
  recipient.generateKeys();
  const input = {
    owner,
    allowPeerExtension: false,
    recipientPublicKey: recipient.getPublicKey().toString('base64url'),
  };
  const issue = changes =>
    f.call('/v1/bundle', {...input, ...changes}, session.accessToken);
  const list = changes =>
    f.call('/v1/groups/list', {owner, ...changes}, session.accessToken);
  const response = await issue({});
  assert.equal(response.status, 200);
  const unnamed = await response.json();
  assert.equal(unnamed.groupName, '');
  await f.restart();
  assert.equal(
    (await (await issue({groupName: ''})).json()).bundle,
    unnamed.bundle,
  );
  assert.equal((await issue({allowPeerExtension: true})).status, 409);
  const named = await issue({groupName: 'treasury', allowPeerExtension: true});
  assert.equal(named.status, 200);
  assert.notEqual((await named.json()).bundle, unnamed.bundle);
  assert.deepEqual(
    (await (await list({})).json()).groups.map(group => group.name),
    ['', 'treasury'],
  );
  assert.deepEqual(
    (await (await list({after: ''})).json()).groups.map(group => group.name),
    ['treasury'],
  );
  assert.equal((await list({after: null})).status, 400);
  assert.equal(
    (
      await f.call(
        '/v1/namespaces/name',
        {owner, displayName: ''},
        session.accessToken,
      )
    ).status,
    400,
  );
  const stub = await f.stub();
  for (let i = 0; i < 100; i++)
    await stub.group(owner, `n${String(i).padStart(3, '0')}`, false);
  const first = await (await list({})).json();
  assert.equal(first.groups[0].name, '');
  assert.equal(first.next, 'n098');
  const second = await (await list({after: first.next})).json();
  assert.deepEqual(
    second.groups.map(group => group.name),
    ['n099', 'treasury'],
  );
  assert.equal(second.next, null);
});

test('workerd rejects an invalid OIDC nonce before a session exists', async t => {
  const f = await setup(t),
    flow = await f.begin(),
    attempt = await f.oauth(flow);
  f.upstream.claims.nonce = 'wrong';
  assert.equal(
    (await f.call(attempt.callback, undefined, undefined, flow.headers)).status,
    303,
  );
  await t.waitFor(() =>
    f.upstream.logs.some(log => log.message.startsWith('[oidc] ')),
  );
  assert.deepEqual(
    f.upstream.logs.map(log => log.message),
    ['[oidc] {"provider":"google","check":"nonce"}'],
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

for (const provider of ['google', 'github'])
  test(`workerd ${provider} exchange logs only bounded OAuth error fields`, async t => {
    const f = await setup(t),
      flow = await f.begin(),
      attempt = await f.oauth(flow, provider);
    const privateValues = ['fixture-token'];
    f.upstream.tokenResponse = form => {
      privateValues.push(
        form.get('code'),
        form.get('code_verifier'),
        form.get('client_secret'),
      );
      const fields = {
        error: 'invalid_grant',
        error_description: 'Code exchange rejected. ' + privateValues.join(' '),
        access_token: privateValues[0],
      };
      return provider === 'google'
        ? Response.json(fields, {status: 400})
        : new Response(new URLSearchParams(fields), {status: 401});
    };
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
    assert.equal(context.error, `${provider}_authorization_failed`);
    assert.equal(context.account, null);
    await t.waitFor(() =>
      f.upstream.logs.some(log => log.message.startsWith('[oauth] ')),
    );
    assert.equal(f.upstream.logs.length, 1);
    const {level, message} = f.upstream.logs[0];
    assert.equal(level, 'warn');
    assert.deepEqual(JSON.parse(message.slice('[oauth] '.length)), {
      provider,
      status: provider === 'google' ? 400 : 401,
      error: 'invalid_grant',
      error_description:
        'Code exchange rejected. [redacted] [redacted] [redacted] [redacted]',
    });
    for (const secret of privateValues) assert.ok(!message.includes(secret));
  });

for (const contract of [false, true])
  test(`workerd validates ${contract ? 'ERC-1271 via RPC' : 'EOA'} SIWE and rejects replay`, async t => {
    const f = await setup(t),
      flow = await f.begin(),
      address = contract ? '0x' + '22'.repeat(20) : signer.address;
    const challenge = await (
      await f.call(
        '/auth/login/wallet/nonce',
        {flow: flow.flow, address, chainId: 'eip155:1'},
        undefined,
        flow.headers,
      )
    ).json();
    const signature = contract
      ? '0x1234'
      : await signer.signMessage({message: challenge.message});
    const input = {flow: flow.flow, message: challenge.message, signature};
    const verified = await f.call(
      '/auth/login/wallet/verify',
      input,
      undefined,
      flow.headers,
    );
    assert.equal(verified.status, 200, await verified.clone().text());
    assert.equal(
      (
        await f.call(
          '/auth/login/wallet/verify',
          input,
          undefined,
          flow.headers,
        )
      ).status,
      400,
    );
    const session = await (
      await f.call('/auth/login/token', await f.complete(flow))
    ).json();
    assert.equal(session.account.id, 'eip155:' + address.toLowerCase());
    const stub = await f.stub(),
      key = 'session:' + (await tokenHash(session.accessToken)),
      saved = await stub.get(key);
    const cap = JSON.parse(await stub.openSession(saved)).absoluteExpiresAt;
    assert.equal(await stub.touchSession(key, cap), true);
    await stub.remove(key);
    await stub.put(key, saved, '', Date.now() - 1);
    assert.equal(await stub.touchSession(key, cap), false);
    assert.equal(
      (await f.call('/v1/me', undefined, session.accessToken)).status,
      401,
    );
    await stub.remove(key);
    assert.equal(await stub.touchSession(key, cap), false);
  });

test('first internal key generation retires old credentials once while retaining group policy', async context => {
  const root = await mkdtemp(join(tmpdir(), 'monoid-authority-runtime-'));
  // Test-only previous deployment: data exists, but there is no internal key.
  // This fixture cannot be bundled into the production entrypoint.
  const legacy = `
    import {DurableObject} from 'cloudflare:workers';
    export class AuthorityState extends DurableObject {
      async seed() {
        const sql = this.ctx.storage.sql;
        sql.exec("CREATE TABLE records (key TEXT PRIMARY KEY, value TEXT NOT NULL, proof TEXT NOT NULL, expires INTEGER NOT NULL)");
        sql.exec("CREATE TABLE groups (owner_source TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL, allow_peer_extension INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (owner_source, owner_id, name))");
        sql.exec("CREATE TABLE namespace_names (source TEXT NOT NULL, id TEXT NOT NULL, display_name TEXT NOT NULL, PRIMARY KEY (source, id))");
        sql.exec("INSERT INTO records VALUES (?, ?, ?, ?)", "session:retired", "old-ciphertext", "", Date.now() + 3600000);
        sql.exec("INSERT INTO records VALUES (?, ?, ?, ?)", "login-code:retired", "old-grant", "", Date.now() + 60000);
        sql.exec("INSERT INTO groups VALUES (?, ?, ?, ?, ?)", "github-user", "7", "retained", 0, 123);
        sql.exec("INSERT INTO namespace_names VALUES (?, ?, ?)", "github-user", "7", "Existing name");
      }
    }
    export default { async fetch(request, env) {
      await env.AUTHORITY_STATE.getByName('authority').seed();
      return new Response('seeded');
    }};
  `;
  let mf = new Miniflare(options(root, providerFixture(), legacy));
  context.after(async () => {
    await mf.dispose();
    await removePersistence(root);
  });
  assert.equal((await mf.dispatchFetch(base)).status, 200);
  await mf.dispose();
  mf = new Miniflare(options(root, providerFixture()));
  const namespace = await mf.getDurableObjectNamespace('AUTHORITY_STATE');
  const stub = namespace.getByName('authority');
  const metadata = await stub.metadata();
  const publicKey = metadata.publicKey;
  assert.equal(Buffer.from(publicKey, 'base64url').length, 65);
  for (const key of [
    'session:retired',
    'login-code:retired',
    'authority-keys:v1',
  ])
    assert.equal(await stub.get(key), null);
  const owner = {source: 'github-user', id: '7'};
  const retained = await stub.group(owner, 'retained', true);
  assert.equal(retained.name, 'retained');
  assert.equal(retained.allowPeerExtension, false);
  assert.equal(retained.createdAt, 123);
  assert.equal(
    (await stub.namespace(owner, 'Provider name')).displayName,
    'Existing name',
  );
  await stub.put('current-record', 'survives-restart', '', Date.now() + 60000);
  await mf.dispose();
  mf = new Miniflare(options(root, providerFixture()));
  const restarted = (
    await mf.getDurableObjectNamespace('AUTHORITY_STATE')
  ).getByName('authority');
  assert.equal((await restarted.metadata()).publicKey, publicKey);
  assert.equal(await restarted.get('current-record'), 'survives-restart');
});
