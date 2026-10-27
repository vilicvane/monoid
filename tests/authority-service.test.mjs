import assert from 'node:assert/strict';
import {mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {base64urlnopad} from '@scure/base';
import {autorun} from 'mobx';

import {pinClock} from './helpers/held-pins.mjs';

let state;
mock.module('@capacitor/app', {
  namedExports: {
    App: {
      addListener: async (name, callback) => {
        state.listeners.set(name, callback);
        return {remove: async () => {}};
      },
      getLaunchUrl: async () => state.launch && {url: state.launch},
    },
  },
});
mock.module('@capacitor/browser', {
  namedExports: {
    Browser: {
      addListener: async (name, callback) => {
        state.listeners.set(name, callback);
        return {remove: async () => {}};
      },
      open: async options => {
        state.opened.push(options);
        await state.onOpen?.();
      },
      close: async () => {
        state.closed++;
        state.listeners.get('browserFinished')?.();
        await state.onClose?.();
      },
    },
  },
});
const {AuthorityService} = await import(
  '../.bld/app/@services/authority-service.js'
);
const {
  AUTHORITY_CALLBACK_URI,
  AuthorityAccount,
  AuthorityError,
  authorityPKCEChallenge,
} = await import('../.bld/app/@lib/authority-client.js');

test('account requires the hosted sign-in method and retains optional verified email and provider', () => {
  for (const method of ['wallet', 'email', 'social']) {
    for (const email of [undefined, 'person@example.com']) {
      const account = {
        id: 'account',
        login: 'address',
        method,
        ...(email && {email}),
        ...(method === 'social' && {provider: 'github'}),
      };
      assert.deepEqual(AuthorityAccount.satisfies(account), account);
      if (method === 'social') {
        delete account.provider;
        assert.deepEqual(AuthorityAccount.satisfies(account), account);
      }
    }
  }
  assert.throws(() =>
    AuthorityAccount.satisfies({id: 'account', login: 'address'}),
  );
  assert.throws(() =>
    AuthorityAccount.satisfies({
      id: 'account',
      login: 'address',
      method: 'unknown',
    }),
  );
});
const BASE = 'https://authority.monoid.app/';
const ACCOUNT = {
  id: 'account-id',
  login: 'account-name',
  method: 'social',
  email: 'person@example.com',
  provider: 'github',
};
const OWNER = {source: 'reown', id: 'project:profile'};
const CODE = base64urlnopad.encode(new Uint8Array(32).fill(3));
const BEARER = 'opaque-test-bearer';
const encoded = (length, value = 4) =>
  base64urlnopad.encode(new Uint8Array(length).fill(value));
const callback = (
  saved,
  values = {code: CODE},
  base = AUTHORITY_CALLBACK_URI,
) => `${base}?${new URLSearchParams({...values, state: saved.state})}`;
const failure = code => error =>
  error instanceof AuthorityError && error.code === code;
const flush = async () => {
  for (let i = 0; i < 5; i++) await setImmediate();
};

async function fixture(t, {saved, launch} = {}) {
  const clock = pinClock(t);
  clock.elapse(999_000);
  const current = (state = {
    clock,
    saved: structuredClone(saved),
    launch,
    listeners: new Map(),
    opened: [],
    closed: 0,
    writes: [],
    requests: [],
    elapse(ms) {
      clock.elapse(ms);
    },
    async tick(ms) {
      clock.tick(ms);
      await flush();
    },
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname;
    const request = {
      path,
      options,
      body: options.body && JSON.parse(options.body),
    };
    current.requests.push(request);
    const custom = await current.respond?.(request);
    if (custom) return custom;
    if (path === '/auth/login/start')
      return Response.json({
        authorizationUrl: `${BASE}auth/login?request=opaque`,
        expiresIn: 600,
      });
    if (path === '/auth/login/token')
      return Response.json({
        accessToken: BEARER,
        tokenType: 'Bearer',
        expiresIn: 300,
        account: ACCOUNT,
      });
    if (path === '/auth/logout') return new Response(null, {status: 204});
    if (path === '/v1/namespaces')
      return Response.json({namespaces: [{...OWNER, displayName: 'Personal'}]});
    throw new Error('Unexpected test request');
  });
  current.storage = {
    get: async key => {
      assert.equal(key, 'authorityLogin');
      return structuredClone(current.saved);
    },
    set: async (key, value) => {
      assert.equal(key, 'authorityLogin');
      await current.beforeSet?.();
      current.saved = structuredClone(value);
      current.writes.push(structuredClone(value));
    },
    remove: async key => {
      assert.equal(key, 'authorityLogin');
      current.saved = undefined;
    },
  };
  current.service = await AuthorityService.create(current.storage);
  return current;
}

async function signedIn(t) {
  const current = await fixture(t);
  const signIn = current.service.signIn();
  await flush();
  await current.service.handleCallback(callback(current.saved));
  await signIn;
  return current;
}

test('PKCE S256 matches RFC 7636 without WebCrypto digest or randomUUID', () => {
  assert.equal(
    authorityPKCEChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('policy conflicts name bundles in the UI', () => {
  assert.equal(
    new AuthorityError('bundle_policy_conflict').message,
    'A bundle with this name has a different policy.',
  );
});

test('sign-in persists only PKCE flow data, opens the hosted URL, and publishes an in-memory session', async t => {
  const current = await fixture(t);
  t.mock.method(crypto, 'randomUUID', () =>
    assert.fail('HTTP WebView has no randomUUID'),
  );
  const observed = [];
  t.after(autorun(() => observed.push(current.service.signedIn)));
  const result = current.service.signIn();
  assert.equal(current.service.pendingSignIn, result);
  assert.equal(current.service.signIn(), result);
  await flush();
  const saved = structuredClone(current.saved);
  assert.match(saved.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(saved.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(saved.state, saved.codeVerifier);
  assert.deepEqual(current.requests[0].body, {
    redirectUri: AUTHORITY_CALLBACK_URI,
    state: saved.state,
    codeChallenge: authorityPKCEChallenge(saved.codeVerifier),
    codeChallengeMethod: 'S256',
  });
  assert.equal(saved.expiresAt, Date.now() + 600_000);
  assert.deepEqual(current.opened, [{url: `${BASE}auth/login?request=opaque`}]);
  assert(!current.opened[0].url.includes(saved.codeVerifier));
  current.listeners.get('appUrlOpen')({url: callback(saved)});
  assert.deepEqual(await result, ACCOUNT);
  assert.deepEqual(current.service.account, ACCOUNT);
  assert.deepEqual(observed, [false, true]);
  assert.equal(current.service.signInState.status, 'complete');
  assert.equal(current.saved, undefined);
  assert.equal(current.closed, 1);
  assert.equal(current.requests[1].body.codeVerifier, saved.codeVerifier);
  assert.equal(current.requests[1].body.redirectUri, AUTHORITY_CALLBACK_URI);
  assert(!JSON.stringify(current.writes).includes(BEARER));
  assert(!JSON.stringify(current.writes).includes(ACCOUNT.id));
  assert.deepEqual(await current.service.namespaces(), [
    {...OWNER, displayName: 'Personal'},
  ]);
  assert.equal(
    current.requests.at(-1).options.headers.Authorization,
    `Bearer ${BEARER}`,
  );
});

test('wrong state, scheme, path, fragment and duplicate query parameters leave the real login pending', async t => {
  const current = await fixture(t);
  const result = current.service.signIn();
  await flush();
  const saved = current.saved;
  for (const url of [
    callback({...saved, state: 'wrong'}),
    callback(saved, {code: CODE}, 'other://authority/callback'),
    callback(saved, {code: CODE}, 'app.monoid://authority/elsewhere'),
    callback(saved, {code: CODE}, 'app.monoid://other/callback'),
    `${callback(saved)}#fragment`,
    `${callback(saved)}&code=duplicate`,
    callback(saved, {error: 'access_denied', code: CODE}),
  ]) {
    await assert.rejects(
      current.service.handleCallback(url),
      failure('invalid_callback'),
    );
    assert.equal(current.service.pendingSignIn, result);
    assert.deepEqual(current.saved, saved);
  }
  assert.equal(current.requests.length, 1);
  await current.service.handleCallback(callback(saved));
  await result;
  await assert.rejects(
    current.service.handleCallback(callback(saved)),
    failure('invalid_callback'),
  );
  assert.equal(
    current.requests.filter(item => item.path === '/auth/login/token').length,
    1,
  );
});

for (const cancel of ['hosted page', 'explicit', 'expired']) {
  test(`${cancel} settles sign-in and clears the persisted verifier`, async t => {
    const current = await fixture(t);
    const result = current.service.signIn();
    await flush();
    const rejected = assert.rejects(
      result,
      failure(cancel === 'expired' ? 'expired' : 'cancelled'),
    );
    if (cancel === 'hosted page')
      await assert.rejects(
        current.service.handleCallback(
          callback(current.saved, {error: 'access_denied'}),
        ),
        failure('cancelled'),
      );
    if (cancel === 'explicit') await current.service.cancelSignIn();
    if (cancel === 'expired') {
      current.elapse(600_000);
      await assert.rejects(
        current.service.handleCallback(callback(current.saved)),
        failure('expired'),
      );
    }
    await rejected;
    assert.equal(current.saved, undefined);
    assert.equal(current.service.signedIn, false);
    assert.equal(current.requests.length, 1);
  });
}

test('pending flow expiry proactively clears storage', async t => {
  const current = await fixture(t);
  const result = current.service.signIn();
  await flush();
  const rejected = assert.rejects(result, failure('expired'));
  await current.tick(600_000);
  await rejected;
  assert.equal(current.saved, undefined);
});

test('a server-expired one-use code settles as expired without a retry', async t => {
  const current = await fixture(t);
  const result = current.service.signIn();
  await flush();
  current.respond = () =>
    Response.json({error: 'invalid_grant'}, {status: 400});
  const rejected = assert.rejects(result, failure('expired'));
  await current.service.handleCallback(callback(current.saved));
  await rejected;
  assert.equal(current.saved, undefined);
  assert.equal(
    current.requests.filter(item => item.path === '/auth/login/token').length,
    1,
  );
});

test('an authorization URL outside this Authority is never opened', async t => {
  const current = await fixture(t);
  current.respond = () =>
    Response.json({
      authorizationUrl: 'https://other.example/auth/login',
      expiresIn: 600,
    });
  await assert.rejects(current.service.signIn(), failure('service_error'));
  assert.equal(current.opened.length, 0);
  assert.equal(current.saved, undefined);
});

test('cancellation while Browser opens waits for it and closes it before settling', async t => {
  const current = await fixture(t);
  const opening = Promise.withResolvers();
  current.onOpen = () => opening.promise;
  const result = current.service.signIn();
  await flush();
  const rejected = assert.rejects(result, failure('cancelled'));
  const cancelled = current.service.cancelSignIn();
  await flush();
  assert.equal(current.closed, 0);
  opening.resolve();
  await cancelled;
  await rejected;
  assert.equal(current.closed, 1);
  assert.equal(current.saved, undefined);
});

test('cold launch redeems the persisted pending flow without opening another browser', async t => {
  const saved = {
    authorityUrl: BASE,
    state: encoded(32, 1),
    codeVerifier: encoded(32, 2),
    expiresAt: 1_500_000,
  };
  const current = await fixture(t, {saved, launch: callback(saved)});
  await flush();
  assert.deepEqual(current.service.account, ACCOUNT);
  assert.equal(current.saved, undefined);
  assert.equal(current.opened.length, 0);
  assert.equal(current.requests.length, 1);
  assert.equal(current.requests[0].body.codeVerifier, saved.codeVerifier);
});

test('an expired saved flow is removed and its cold callback cannot sign in', async t => {
  const saved = {
    authorityUrl: BASE,
    state: encoded(32, 1),
    codeVerifier: encoded(32, 2),
    expiresAt: 999_999,
  };
  const current = await fixture(t, {saved, launch: callback(saved)});
  await flush();
  assert.equal(current.saved, undefined);
  assert.equal(current.service.signedIn, false);
  assert.equal(current.requests.length, 0);
});

test('duplicate callback during redemption is rejected; browserFinished cannot cancel a claimed code', async t => {
  const current = await fixture(t);
  const token = Promise.withResolvers();
  current.respond = request =>
    request.path === '/auth/login/token' ? token.promise : undefined;
  const result = current.service.signIn();
  await flush();
  const url = callback(current.saved);
  const completing = current.service.handleCallback(url);
  await flush();
  await assert.rejects(
    current.service.handleCallback(url),
    failure('invalid_callback'),
  );
  current.listeners.get('browserFinished')();
  token.resolve(
    Response.json({
      accessToken: BEARER,
      tokenType: 'Bearer',
      expiresIn: 900,
      account: ACCOUNT,
    }),
  );
  await completing;
  assert.deepEqual(await result, ACCOUNT);
});

test('cancellation during persistence cannot leave a late pending record or open the browser', async t => {
  const current = await fixture(t);
  const write = Promise.withResolvers();
  current.beforeSet = () => write.promise;
  const result = current.service.signIn();
  await flush();
  const rejected = assert.rejects(result, failure('cancelled'));
  const cancelled = current.service.cancelSignIn();
  write.resolve();
  await cancelled;
  await rejected;
  assert.equal(current.saved, undefined);
  assert.equal(current.opened.length, 0);
});

test('late token response after cancellation never restores a session', async t => {
  const current = await fixture(t);
  const token = Promise.withResolvers();
  current.respond = request =>
    request.path === '/auth/login/token' ? token.promise : undefined;
  const result = current.service.signIn();
  await flush();
  const completing = current.service.handleCallback(callback(current.saved));
  await flush();
  const rejected = assert.rejects(result, failure('cancelled'));
  await current.service.cancelSignIn();
  await rejected;
  token.resolve(
    Response.json({
      accessToken: BEARER,
      tokenType: 'Bearer',
      expiresIn: 900,
      account: ACCOUNT,
    }),
  );
  await completing;
  assert.equal(current.service.signedIn, false);
  assert.equal(
    current.requests.filter(request => request.path === '/auth/logout').length,
    1,
  );
});

for (const mode of ['timer', 'wall clock', '401']) {
  test(`${mode} clears the observable session`, async t => {
    const current = await signedIn(t);
    if (mode === 'timer') await current.tick(300_000);
    else if (mode === 'wall clock') current.elapse(300_000);
    else
      current.respond = () =>
        Response.json({error: 'unauthorized'}, {status: 401});
    await assert.rejects(current.service.namespaces(), failure('unauthorized'));
    assert.equal(current.service.signedIn, false);
    assert.equal(current.service.account, undefined);
    await current.service.signOut();
    const logouts = current.requests.filter(
      request => request.path === '/auth/logout',
    );
    assert.equal(logouts.length, 1);
    assert.equal(logouts[0].options.headers.Authorization, `Bearer ${BEARER}`);
  });
}

test('idle expiry logs out even while the UI keeps reading the account', async t => {
  const current = await signedIn(t);
  const observed = [];
  t.after(autorun(() => observed.push(current.service.signedIn)));
  await current.tick(240_000);
  assert.deepEqual(current.service.account, ACCOUNT);
  assert.equal(current.service.signedIn, true);
  await current.tick(60_000);
  assert.deepEqual(observed, [true, false]);
  assert.equal(
    current.requests.filter(request => request.path === '/auth/logout').length,
    1,
  );
});

test('authenticated requests every four minutes slide past the token window until a server 401', async t => {
  const current = await signedIn(t);
  for (let i = 0; i < 3; i++) {
    await current.tick(240_000);
    await current.service.namespaces();
    assert.equal(current.service.signedIn, true);
  }
  await current.tick(240_000);
  assert.equal(current.service.signedIn, true);
  assert.equal(
    current.requests.filter(request => request.path === '/auth/logout').length,
    0,
  );
  current.respond = () => Response.json({error: 'unauthorized'}, {status: 401});
  await assert.rejects(current.service.namespaces(), failure('unauthorized'));
  assert.equal(current.service.signedIn, false);
  assert.equal(
    current.requests.filter(request => request.path === '/auth/logout').length,
    1,
  );
});

test('public Authority requests do not renew the authenticated idle window', async t => {
  const current = await signedIn(t);
  await current.tick(240_000);
  current.respond = ({path}) =>
    path === '/v1/metadata'
      ? Response.json({
          publicKey: encoded(65),
          bundle: 'hpke-auth-p256-sha256-aes128gcm',
          time: {
            protocol: 'monoid-authority-time',
            version: 1,
            algorithm: 'ecdsa-p256-sha256-p1363',
          },
        })
      : undefined;
  await current.service.metadata();
  await current.tick(60_000);
  assert.equal(current.service.signedIn, false);
  assert.equal(
    current.requests.filter(request => request.path === '/auth/logout').length,
    1,
  );
});

for (const expiresIn of [-1, 0, 1, 300, 900, 901]) {
  test(`token expiresIn ${expiresIn} is validated without becoming a fixed deadline`, async t => {
    const current = await fixture(t);
    current.respond = ({path}) =>
      path === '/auth/login/token'
        ? Response.json({
            accessToken: BEARER,
            tokenType: 'Bearer',
            expiresIn,
            account: ACCOUNT,
          })
        : undefined;
    const login = current.service.signIn();
    const valid = expiresIn > 0 && expiresIn <= 900;
    const result = valid
      ? login
      : assert.rejects(login, failure('service_error'));
    await flush();
    await current.service.handleCallback(callback(current.saved));
    await result;
    assert.equal(current.service.signedIn, valid);
    if (valid) {
      await current.tick(240_000);
      await current.service.namespaces();
      await current.tick(240_000);
      assert.equal(current.service.signedIn, true);
    }
  });
}

test('suspended timers cannot retain an idle session', async t => {
  const current = await signedIn(t);
  current.elapse(300_000);
  await assert.rejects(current.service.namespaces(), failure('unauthorized'));
  assert.equal(current.service.account, undefined);
  assert.equal(
    current.requests.filter(request => request.path === '/auth/logout').length,
    1,
  );
});

test('hiding logs out and clears synchronously without waiting for the network', async t => {
  const current = await signedIn(t);
  const logout = Promise.withResolvers();
  current.respond = ({path}) =>
    path === '/auth/logout' ? logout.promise : undefined;
  current.clock.visibility('hidden');
  assert.equal(current.service.account, undefined);
  assert.equal(current.requests.at(-1).path, '/auth/logout');
  assert.equal(
    current.requests.at(-1).options.headers.Authorization,
    `Bearer ${BEARER}`,
  );
  current.clock.visibility('visible');
  assert.equal(current.service.signedIn, false);
  await current.service.signOut();
  assert.equal(
    current.requests.filter(request => request.path === '/auth/logout').length,
    1,
  );
  logout.reject(new Error('offline'));
  await flush();
});

test('a late 401 from an ended session cannot sign out its replacement', async t => {
  const current = await signedIn(t);
  const pending = Promise.withResolvers();
  current.respond = ({path}) =>
    path === '/v1/namespaces' ? pending.promise : undefined;
  const request = current.service.namespaces();
  const rejected = assert.rejects(request, failure('unauthorized'));
  await current.service.signOut();
  const login = current.service.signIn();
  await flush();
  await current.service.handleCallback(callback(current.saved));
  await login;
  pending.resolve(Response.json({error: 'unauthorized'}, {status: 401}));
  await rejected;
  assert.equal(current.service.signedIn, true);
  assert.equal(
    current.requests.filter(request => request.path === '/auth/logout').length,
    1,
  );
});

test('sign-out during callback cleanup cannot publish a late bearer', async t => {
  const current = await fixture(t);
  const closing = Promise.withResolvers();
  current.onClose = () => closing.promise;
  const login = current.service.signIn();
  const rejected = assert.rejects(login, failure('cancelled'));
  await flush();
  const callbackDone = current.service.handleCallback(callback(current.saved));
  await flush();
  const ended = current.service.signOut();
  closing.resolve();
  await ended;
  await callbackDone;
  await rejected;
  assert.equal(current.service.signedIn, false);
  assert.equal(
    current.requests.filter(request => request.path === '/auth/logout').length,
    1,
  );
});

test('sign-out clears locally even when logout fails', async t => {
  const current = await signedIn(t);
  current.respond = () =>
    Response.json({error: 'internal_error'}, {status: 500});
  await current.service.signOut();
  assert.equal(current.service.signedIn, false);
  assert.equal(current.requests.at(-1).path, '/auth/logout');
  assert.equal(current.requests.at(-1).options.method, 'POST');
});

test('groups follows each cursor and bundle issuance encodes and decodes bytes', async t => {
  const current = await signedIn(t);
  const groups = [
    {name: 'A', allowPeerExtension: false, createdAt: 10},
    {name: 'B', allowPeerExtension: true, createdAt: 20},
  ];
  current.respond = ({path, body}) => {
    assert.deepEqual(body.owner, OWNER);
    if (path === '/v1/groups/list')
      return Response.json({
        owner: OWNER,
        groups: [groups[body.after ? 1 : 0]],
        next: body.after ? null : 'A',
      });
    assert.equal(body.recipientPublicKey, encoded(65));
    return Response.json({
      publicKey: encoded(65),
      data: encoded(182),
      bundle: encoded(32),
      owner: OWNER,
      groupName: 'A',
      allowPeerExtension: false,
    });
  };
  assert.deepEqual(await current.service.groups(OWNER), groups);
  const calls = current.requests.filter(
    request => request.path === '/v1/groups/list',
  );
  assert.deepEqual(
    calls.map(request => request.body),
    [{owner: OWNER}, {owner: OWNER, after: 'A'}],
  );
  const result = await current.service.issueBundle({
    owner: OWNER,
    groupName: 'A',
    allowPeerExtension: false,
    recipientPublicKey: new Uint8Array(65).fill(4),
  });
  assert.deepEqual(result, {
    publicKey: new Uint8Array(65).fill(4),
    data: new Uint8Array(182).fill(4),
    bundle: new Uint8Array(32).fill(4),
    owner: OWNER,
    groupName: 'A',
    allowPeerExtension: false,
  });
});

for (const [status, code] of [
  [409, 'bundle_policy_conflict'],
  [429, 'rate_limited'],
  [503, 'service_error'],
]) {
  test(`${status} maps to the typed ${code} error without signing out`, async t => {
    const current = await signedIn(t);
    current.respond = () => Response.json({error: code}, {status});
    await assert.rejects(current.service.namespaces(), failure(code));
    assert.equal(current.service.signedIn, true);
  });
}

test('public metadata decodes its key and network failures stay sanitized', async t => {
  const current = await fixture(t);
  const metadata = {
    publicKey: encoded(65),
    bundle: 'hpke-auth-p256-sha256-aes128gcm',
    time: {
      protocol: 'monoid-authority-time',
      version: 1,
      algorithm: 'ecdsa-p256-sha256-p1363',
    },
  };
  current.respond = () => Response.json(metadata);
  assert.deepEqual(await current.service.metadata(), {
    ...metadata,
    publicKey: new Uint8Array(65).fill(4),
  });
  assert.equal(current.requests[0].options.headers.Authorization, undefined);
  current.respond = () => {
    throw new Error('sensitive upstream detail');
  };
  await assert.rejects(
    current.service.metadata(),
    error =>
      failure('network_error')(error) && !String(error).includes('sensitive'),
  );
});

test('browser finish before the callback releases UI busy state but still completes login', async t => {
  const current = await fixture(t);
  const result = current.service.signIn();
  await flush();
  const saved = current.saved;
  current.listeners.get('browserFinished')();
  assert.equal(current.service.signInState.status, 'idle');
  assert.deepEqual(current.saved, saved);
  assert.equal(current.service.pendingSignIn, result);
  await current.service.handleCallback(callback(saved));
  assert.deepEqual(await result, ACCOUNT);
  assert.equal(current.service.signedIn, true);
});

test('sign-in after browser finish replaces the old pending callback', async t => {
  const current = await fixture(t);
  const original = current.service.signIn();
  await flush();
  const saved = current.saved;
  current.listeners.get('browserFinished')();
  const rejected = assert.rejects(original, failure('cancelled'));
  const replacement = current.service.signIn();
  assert.notEqual(replacement, original);
  assert.equal(current.service.signIn(), replacement);
  await rejected;
  await flush();
  assert.notEqual(current.saved.state, saved.state);
  assert.equal(current.opened.length, 2);
  await assert.rejects(
    current.service.handleCallback(callback(saved)),
    failure('invalid_callback'),
  );
  await current.service.handleCallback(callback(current.saved));
  assert.deepEqual(await replacement, ACCOUNT);
});
