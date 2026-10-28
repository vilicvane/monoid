import assert from 'node:assert/strict';
import {mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {base64urlnopad} from '@scure/base';
import {autorun} from 'mobx';

import {pinClock} from './helpers/held-pins.mjs';

let state;
mock.module('@ionic/storage', {
  namedExports: {
    Storage: class {
      async create() {}
      async get(key) {
        return structuredClone(state.storage.get(key));
      }
      async set(key, value) {
        await state.beforeSet?.(key, value);
        state.storage.set(key, structuredClone(value));
      }
      async remove(key) {
        state.storage.delete(key);
      }
    },
  },
});
mock.module('@capacitor/app', {
  namedExports: {
    App: {
      async addListener(name, listener) {
        state.listeners.set(name, listener);
        return {remove: async () => state.listeners.delete(name)};
      },
      async getLaunchUrl() {
        if (state.deliverLaunchTwice)
          state.listeners.get('appUrlOpen')({url: state.launchUrl});
        return state.launchUrl ? {url: state.launchUrl} : undefined;
      },
    },
  },
});
mock.module('@capacitor/app-launcher', {
  namedExports: {
    AppLauncher: {
      openUrl: async options => {
        state.opened.push(options);
        return (await state.onOpen?.(options)) ?? {completed: true};
      },
    },
  },
});
const {AuthorityService} = await import(
  '../.bld/app/@services/authority-service.js'
);
const {StorageService} = await import(
  '../.bld/app/@services/storage-service.js'
);
const {
  AUTHORITY_CALLBACK_URI,
  AuthorityAccount,
  AuthorityError,
  AuthorityOwner,
  authorityPKCEChallenge,
} = await import('../.bld/app/@lib/authority-client.js');

test('accounts use provider-native IDs and organizations are owners only', () => {
  for (const source of ['google', 'github-user', 'wallet']) {
    const account = {source, id: 'provider-id', displayName: 'Visible name'};
    assert.deepEqual(AuthorityAccount.satisfies(account), account);
    assert.deepEqual(AuthorityOwner.sanitize(account), {
      source,
      id: account.id,
    });
    assert.equal(AuthorityAccount.is({source, id: account.id}), false);
  }
  const organization = {source: 'github-organization', id: '12345'};
  assert.deepEqual(AuthorityOwner.satisfies(organization), organization);
  assert.equal(
    AuthorityAccount.is({...organization, displayName: 'Team'}),
    false,
  );
  for (const source of ['reown', 'email', 'social']) {
    assert.equal(
      AuthorityAccount.is({source, id: 'old', displayName: 'Old'}),
      false,
    );
    assert.equal(AuthorityOwner.is({source, id: 'old'}), false);
  }
});
const BASE = 'https://authority.monoid.app/';
const ACCOUNT = {
  source: 'google',
  id: 'google-sub',
  displayName: 'person@example.com',
};
const OWNER = {source: ACCOUNT.source, id: ACCOUNT.id};
const CODE = base64urlnopad.encode(new Uint8Array(32).fill(3));
const BEARER = 'opaque-test-bearer';
const encoded = (length, value = 4) =>
  base64urlnopad.encode(new Uint8Array(length).fill(value));
const callback = (
  pending,
  values = {code: CODE},
  base = AUTHORITY_CALLBACK_URI,
) => `${base}?${new URLSearchParams({...values, state: pending.state})}`;
const failure = code => error =>
  error instanceof AuthorityError && error.code === code;
const flush = async () => {
  for (let i = 0; i < 5; i++) await setImmediate();
};

async function fixture(
  t,
  {saved, launchUrl, deliverLaunchTwice, respond} = {},
) {
  const clock = pinClock(t);
  clock.elapse(999_000);
  const current = (state = {
    clock,
    storage: new Map(saved === undefined ? [] : [['authorityLogin', saved]]),
    opened: [],
    listeners: new Map(),
    launchUrl,
    deliverLaunchTwice,
    respond,
    requests: [],
    get pending() {
      return this.requests.findLast(
        request => request.path === '/auth/login/start',
      )?.body;
    },
    complete(url = callback(this.pending)) {
      this.listeners.get('appUrlOpen')({url});
    },
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
  current.service = await AuthorityService.create(
    await StorageService.create(),
  );
  return current;
}

async function signedIn(t) {
  const current = await fixture(t);
  const signIn = current.service.signIn();
  await flush();
  current.complete();
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

test('sign-in persists PKCE before opening the system browser and becomes idle until its callback', async t => {
  const current = await fixture(t);
  assert.equal(current.service.signInState.status, 'idle');
  assert.equal(current.service.pendingSignIn, undefined);
  assert.equal(current.service.signedIn, false);
  t.mock.method(crypto, 'randomUUID', () =>
    assert.fail('HTTP WebView has no randomUUID'),
  );
  const observed = [];
  t.after(autorun(() => observed.push(current.service.signedIn)));
  const result = current.service.signIn();
  assert.equal(current.service.pendingSignIn, result);
  assert.equal(current.service.signInState.status, 'pending');
  await flush();
  const pending = current.pending;
  assert.match(pending.state, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(pending, {
    redirectUri: AUTHORITY_CALLBACK_URI,
    state: pending.state,
    codeChallenge: pending.codeChallenge,
    codeChallengeMethod: 'S256',
  });
  assert.deepEqual(current.opened, [{url: `${BASE}auth/login?request=opaque`}]);
  assert.equal(current.service.signInState.status, 'idle');
  const saved = current.storage.get('authorityLogin');
  assert.deepEqual(saved, {
    authorityUrl: BASE,
    state: pending.state,
    codeVerifier: saved.codeVerifier,
    expiresAt: Date.now() + 600_000,
  });
  current.complete();
  assert.equal(current.service.signInState.status, 'pending');
  assert.deepEqual(await result, ACCOUNT);
  assert.deepEqual(current.service.account, ACCOUNT);
  assert.deepEqual(observed, [false, true]);
  assert.equal(current.service.signInState.status, 'complete');
  const verifier = current.requests[1].body.codeVerifier;
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(pending.state, verifier);
  assert.equal(pending.codeChallenge, authorityPKCEChallenge(verifier));
  assert(!current.opened[0].url.includes(verifier));
  assert.equal(current.requests[1].body.redirectUri, AUTHORITY_CALLBACK_URI);
  assert.equal(current.storage.size, 0);
  assert.deepEqual(await current.service.namespaces(), [
    {...OWNER, displayName: 'Personal'},
  ]);
  assert.equal(
    current.requests.at(-1).options.headers.Authorization,
    `Bearer ${BEARER}`,
  );
});

for (const [label, url] of [
  ['state', pending => callback({...pending, state: 'wrong'})],
  [
    'scheme',
    pending => callback(pending, {code: CODE}, 'other://authority/callback'),
  ],
  [
    'path',
    pending =>
      callback(pending, {code: CODE}, 'app.monoid://authority/elsewhere'),
  ],
  [
    'host',
    pending => callback(pending, {code: CODE}, 'app.monoid://other/callback'),
  ],
  ['fragment', pending => `${callback(pending)}#fragment`],
  ['duplicate code', pending => `${callback(pending)}&code=duplicate`],
  [
    'ambiguous result',
    pending => callback(pending, {error: 'access_denied', code: CODE}),
  ],
]) {
  test(`unrelated callback with invalid ${label} leaves the real login idle and usable`, async t => {
    const current = await fixture(t);
    const result = current.service.signIn();
    await flush();
    current.complete(url(current.pending));
    await flush();
    assert.equal(current.service.pendingSignIn, result);
    assert.equal(current.service.signInState.status, 'idle');
    assert.equal(current.service.signedIn, false);
    assert.equal(current.requests.length, 1);
    current.complete();
    assert.deepEqual(await result, ACCOUNT);
  });
}

for (const cancel of ['hosted page', 'explicit', 'expired']) {
  test(`${cancel} clears the pending login and returns the button to idle`, async t => {
    const current = await fixture(t);
    const result = current.service.signIn();
    await flush();
    const rejected = assert.rejects(
      result,
      failure(cancel === 'expired' ? 'expired' : 'cancelled'),
    );
    if (cancel === 'hosted page')
      current.complete(callback(current.pending, {error: 'access_denied'}));
    if (cancel === 'explicit') await current.service.cancelSignIn();
    if (cancel === 'expired') {
      current.elapse(600_000);
      current.complete();
    }
    await rejected;
    await flush();
    assert.equal(current.service.signInState.status, 'idle');
    assert.equal(current.storage.has('authorityLogin'), false);
    assert.equal(current.service.pendingSignIn, undefined);
    assert.equal(current.service.signedIn, false);
    assert.equal(current.requests.length, 1);
  });
}

test('pending flow expiry proactively releases the attempt', async t => {
  const current = await fixture(t);
  const result = current.service.signIn();
  await flush();
  const rejected = assert.rejects(result, failure('expired'));
  await current.tick(600_000);
  await rejected;
  assert.equal(current.service.pendingSignIn, undefined);
});

test('a server-expired one-use code settles as expired without a retry', async t => {
  const current = await fixture(t);
  const result = current.service.signIn();
  await flush();
  current.respond = () =>
    Response.json({error: 'invalid_grant'}, {status: 400});
  const rejected = assert.rejects(result, failure('expired'));
  current.complete();
  await rejected;
  assert.equal(current.service.pendingSignIn, undefined);
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
  assert.equal(current.service.pendingSignIn, undefined);
});

test('explicit cancellation settles immediately and a late callback cannot consume the next login', async t => {
  const current = await fixture(t);
  const result = current.service.signIn();
  await flush();
  const url = callback(current.pending);
  const rejected = assert.rejects(result, failure('cancelled'));
  await current.service.cancelSignIn();
  await rejected;
  const replacement = current.service.signIn();
  await flush();
  current.complete(url);
  await flush();
  assert.equal(current.service.pendingSignIn, replacement);
  assert.equal(current.service.signedIn, false);
  assert.equal(current.requests.length, 2);
  current.complete();
  assert.deepEqual(await replacement, ACCOUNT);
});

for (const expiresAt of [999_999, 1_500_000]) {
  test(`startup restores only an unexpired login (${expiresAt}) and stays idle`, async t => {
    const saved = {
      authorityUrl: BASE,
      state: encoded(32, 1),
      codeVerifier: encoded(32, 2),
      expiresAt,
    };
    const current = await fixture(t, {saved});
    assert.equal(current.service.signInState.status, 'idle');
    assert.equal(!!current.service.pendingSignIn, expiresAt > Date.now());
    assert.equal(current.service.signedIn, false);
    assert.equal(current.opened.length, 0);
    assert.equal(current.requests.length, 0);
    assert.equal(current.storage.has('authorityLogin'), expiresAt > Date.now());
    if (expiresAt > Date.now()) {
      const restored = current.service.pendingSignIn;
      current.complete(callback(saved));
      assert.equal(current.service.signInState.status, 'pending');
      assert.deepEqual(await restored, ACCOUNT);
      assert.equal(current.opened.length, 0);
      assert.equal(current.requests[0].body.codeVerifier, saved.codeVerifier);
      return;
    }
    const login = current.service.signIn();
    await flush();
    assert.notEqual(current.pending.state, saved.state);
    assert.equal(current.opened.length, 1);
    current.complete();
    assert.deepEqual(await login, ACCOUNT);
  });
}

test('cancellation during login start cannot open the browser later', async t => {
  const current = await fixture(t);
  const start = Promise.withResolvers();
  current.respond = () => start.promise;
  const login = current.service.signIn();
  const rejected = assert.rejects(login, failure('cancelled'));
  await current.service.cancelSignIn();
  start.resolve(
    Response.json({
      authorizationUrl: `${BASE}auth/login?request=opaque`,
      expiresIn: 600,
    }),
  );
  await rejected;
  await flush();
  assert.equal(current.service.pendingSignIn, undefined);
  assert.equal(current.opened.length, 0);
});

for (const deliverLaunchTwice of [false, true]) {
  test(`cold-start callback${deliverLaunchTwice ? ' delivered by both native paths' : ''} redeems once`, async t => {
    const saved = {
      authorityUrl: BASE,
      state: encoded(32, 1),
      codeVerifier: encoded(32, 2),
      expiresAt: 1_500_000,
    };
    const token = Promise.withResolvers();
    const current = await fixture(t, {
      saved,
      launchUrl: callback(saved),
      deliverLaunchTwice,
      respond: ({path}) =>
        path === '/auth/login/token' ? token.promise : undefined,
    });
    const result = current.service.pendingSignIn;
    assert.equal(current.service.signInState.status, 'pending');
    await flush();
    assert.equal(current.storage.has('authorityLogin'), false);
    current.complete(callback(saved));
    assert.equal(current.requests.length, 1);
    assert.equal(current.requests[0].path, '/auth/login/token');
    assert.equal(current.requests[0].body.codeVerifier, saved.codeVerifier);
    token.resolve(
      Response.json({
        accessToken: BEARER,
        tokenType: 'Bearer',
        expiresIn: 300,
        account: ACCOUNT,
      }),
    );
    assert.deepEqual(await result, ACCOUNT);
    current.complete(callback(saved));
    await flush();
    assert.equal(current.requests.length, 1);
    assert.equal(current.opened.length, 0);
  });
}

test('cold start without a pending login ignores an unhandled launch URL', async t => {
  const current = await fixture(t, {
    launchUrl: callback({state: encoded(32, 1)}),
  });
  assert.equal(current.service.signInState.status, 'idle');
  assert.equal(current.service.pendingSignIn, undefined);
  assert.equal(current.requests.length, 0);
});

test('replacement while saving serializes storage and never opens the replaced login', async t => {
  const current = await fixture(t);
  const saving = Promise.withResolvers();
  current.beforeSet = () => saving.promise;
  const original = current.service.signIn();
  const rejected = assert.rejects(original, failure('cancelled'));
  await flush();
  assert.equal(current.opened.length, 0);
  const replacement = current.service.signIn();
  await rejected;
  saving.resolve();
  await flush();
  assert.equal(current.opened.length, 1);
  assert.equal(
    current.storage.get('authorityLogin').state,
    current.pending.state,
  );
  current.complete();
  assert.deepEqual(await replacement, ACCOUNT);
});

test('callback claimed before openUrl resolves keeps exchange loading and is not overwritten by idle', async t => {
  const current = await fixture(t);
  const opening = Promise.withResolvers();
  const token = Promise.withResolvers();
  current.onOpen = () => opening.promise;
  current.respond = ({path}) =>
    path === '/auth/login/token' ? token.promise : undefined;
  const result = current.service.signIn();
  await flush();
  current.complete();
  await flush();
  opening.resolve({completed: true});
  await flush();
  assert.equal(current.service.signInState.status, 'pending');
  token.resolve(
    Response.json({
      accessToken: BEARER,
      tokenType: 'Bearer',
      expiresIn: 300,
      account: ACCOUNT,
    }),
  );
  assert.deepEqual(await result, ACCOUNT);
});

test('pending storage failure never launches a browser', async t => {
  const current = await fixture(t);
  current.beforeSet = () => {
    throw new Error('storage unavailable');
  };
  await assert.rejects(current.service.signIn(), failure('service_error'));
  assert.equal(current.opened.length, 0);
  assert.equal(current.service.pendingSignIn, undefined);
});

test('late token response after cancellation never restores a session', async t => {
  const current = await fixture(t);
  const token = Promise.withResolvers();
  current.respond = request =>
    request.path === '/auth/login/token' ? token.promise : undefined;
  const result = current.service.signIn();
  await flush();
  current.complete();
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
  await flush();
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
    current.complete();
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
  current.complete();
  await login;
  pending.resolve(Response.json({error: 'unauthorized'}, {status: 401}));
  await rejected;
  assert.equal(current.service.signedIn, true);
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

test('groups follows the empty-name cursor and unnamed issuance encodes and decodes bytes', async t => {
  const current = await signedIn(t);
  const groups = [
    {name: '', allowPeerExtension: false, createdAt: 10},
    {name: 'B', allowPeerExtension: true, createdAt: 20},
  ];
  current.respond = ({path, body}) => {
    assert.deepEqual(body.owner, OWNER);
    if (path === '/v1/groups/list')
      return Response.json({
        owner: OWNER,
        groups: [groups[body.after === undefined ? 0 : 1]],
        next: body.after === undefined ? '' : null,
      });
    assert.equal(body.recipientPublicKey, encoded(65));
    assert.equal(body.groupName, '');
    return Response.json({
      publicKey: encoded(65),
      data: encoded(182),
      bundle: encoded(32),
      owner: OWNER,
      groupName: '',
      allowPeerExtension: false,
    });
  };
  assert.deepEqual(await current.service.groups(OWNER), groups);
  const calls = current.requests.filter(
    request => request.path === '/v1/groups/list',
  );
  assert.deepEqual(
    calls.map(request => request.body),
    [{owner: OWNER}, {owner: OWNER, after: ''}],
  );
  const result = await current.service.issueBundle({
    owner: OWNER,
    groupName: '',
    allowPeerExtension: false,
    recipientPublicKey: new Uint8Array(65).fill(4),
  });
  assert.deepEqual(result, {
    publicKey: new Uint8Array(65).fill(4),
    data: new Uint8Array(182).fill(4),
    bundle: new Uint8Array(32).fill(4),
    owner: OWNER,
    groupName: '',
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
      failure('network_error')(error) &&
      error.message === 'Could not connect to the authority.',
  );
});

test('every sign-in replaces the pending login and its old callback is unrelated', async t => {
  const current = await fixture(t);
  const original = current.service.signIn();
  await flush();
  const previous = current.pending;
  const rejected = assert.rejects(original, failure('cancelled'));
  const replacement = current.service.signIn();
  await rejected;
  assert.notEqual(replacement, original);
  await flush();
  assert.notEqual(current.pending.state, previous.state);
  assert.equal(current.opened.length, 2);
  current.complete(callback(previous));
  await flush();
  assert.equal(current.service.signInState.status, 'idle');
  assert.equal(current.service.pendingSignIn, replacement);
  assert.equal(
    current.storage.get('authorityLogin').state,
    current.pending.state,
  );
  assert.equal(current.requests.length, 2);
  current.complete();
  assert.deepEqual(await replacement, ACCOUNT);
});

test('a failed system-browser launch clears the attempt without native error details', async t => {
  const current = await fixture(t);
  current.onOpen = () => {
    throw new Error('native detail');
  };
  const login = current.service.signIn();
  await assert.rejects(login, failure('service_error'));
  assert.equal(current.service.pendingSignIn, undefined);
  assert.equal(
    current.service.signInState.error.message,
    'Authority request failed.',
  );
  assert.equal(current.service.signedIn, false);
});

test('openUrl returning completed false ends loading and removes the saved attempt', async t => {
  const current = await fixture(t);
  current.onOpen = () => ({completed: false});
  const login = current.service.signIn();
  await assert.rejects(login, failure('service_error'));
  await flush();
  assert.equal(current.service.pendingSignIn, undefined);
  assert.equal(current.storage.has('authorityLogin'), false);
  assert.equal(current.service.signInState.status, 'error');
  assert.equal(current.requests.length, 1);
});
