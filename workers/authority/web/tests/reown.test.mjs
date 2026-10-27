import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {test} from 'node:test';
import {createContext, SourceTextModule, SyntheticModule} from 'node:vm';
import {AccountSelection, signInMethod, signInProvider} from '../src/flow.mjs';

const source = stripTypeScriptTypes(
  await readFile(new URL('../src/reown.ts', import.meta.url), 'utf8'),
);
const domainSource = stripTypeScriptTypes(
  await readFile(new URL('../../src/domain.ts', import.meta.url), 'utf8'),
);
const address = '0x' + 'ab'.repeat(20);
const flush = () => new Promise(resolve => setImmediate(resolve));

const authKey = 'monoid-authority-login:project:auth';
const nonceKey = 'monoid-authority-login:project:nonce';

async function setup(t, provider, {signedIn = true} = {}) {
  const storage = new Map([
    [authKey, 'stale-token'],
    [nonceKey, 'stale-nonce'],
    ['monoid-authority-login:other:auth', 'other-project-token'],
  ]);
  const sessionListeners = new Set();
  const state = {
    storage,
    events: [],
    sessionChanged: () => {
      for (const listener of sessionListeners) listener();
    },
    ready: async () => {},
    disconnect: async () => {},
    setSessions: async () => {},
    account: {
      isConnected: true,
      caipAddress: `eip155:1:${address}`,
      ...(provider
        ? {
            embeddedWalletInfo: {
              authProvider: provider,
              user: {email: 'untrusted@example.com'},
            },
          }
        : {}),
    },
    profile: {
      address,
      caip2Network: 'eip155:1',
      email: 'verified@example.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    readProfile: async () => state.profile,
    identities: [],
    errors: 0,
  };
  const appkit = {
    getAccount: () => state.account,
    subscribeAccount: callback => {
      state.accountChanged = callback;
      return () => {};
    },
    open: async () => {},
    close: async () => {},
    ready: () => {
      state.events.push('ready');
      return state.ready();
    },
    disconnect: () => {
      state.events.push('disconnect');
      return state.disconnect();
    },
  };
  const context = createContext({
    location: {origin: 'https://authority.test'},
    document: {documentElement: {}},
    getComputedStyle: () => ({
      getPropertyValue: name =>
        name === '--ion-color-primary' ? ' #5678ab ' : ' system-ui ',
    }),
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      removeItem: key => storage.delete(key),
    },
    window: {addEventListener() {}, removeEventListener() {}},
  });
  const dependencies = {
    '@reown/appkit': {
      createAppKit: options => {
        state.options = options;
        return appkit;
      },
    },
    '@reown/appkit-adapter-ethers': {EthersAdapter: class {}},
    '@reown/appkit-controllers/features': {
      ReownAuthentication: class {
        getSessionAccount() {
          return state.readProfile();
        }
        setSessions(sessions) {
          assert.equal(sessions.length, 0);
          state.events.push('setSessions');
          return state.setSessions();
        }
        on(_, callback) {
          sessionListeners.add(callback);
          return () => sessionListeners.delete(callback);
        }
      },
    },
    '@reown/appkit/networks': {mainnet: {}},
    './flow.mjs': {AccountSelection, signInMethod, signInProvider},
  };
  const module = new SourceTextModule(source, {context});
  await module.link(specifier => {
    if (specifier === '../../src/domain.js')
      return new SourceTextModule(domainSource, {context});
    const exports = dependencies[specifier];
    assert.ok(exports, specifier);
    return new SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [key, value] of Object.entries(exports))
          this.setExport(key, value);
      },
      {context},
    );
  });
  await module.evaluate();
  state.login = module.namespace.createLogin(
    'project',
    value => state.identities.push(value),
    () => state.errors++,
  );
  t.after(() => state.login.stop());
  state.startupStorage = new Map(storage);
  if (signedIn) {
    storage.set(authKey, 'verified-token');
    storage.set(nonceKey, 'fresh-nonce');
    state.sessionChanged();
  }
  await flush();
  return state;
}

for (const [provider, method] of [
  [undefined, 'wallet'],
  ['email', 'email'],
  ['google', 'social'],
]) {
  test(`Reown adapter returns verified ${method} identity and method with the credential`, async t => {
    const state = await setup(t, provider);
    assert.deepEqual(
      {...state.identities.at(-1)},
      {
        login: address,
        email: 'verified@example.com',
        method,
        ...(method === 'social' ? {provider} : {}),
      },
    );
    assert.deepEqual(
      {...(await state.login.credential())},
      {
        token: 'verified-token',
        method,
        ...(method === 'social' ? {provider} : {}),
      },
    );
    assert.equal(state.options.themeVariables['--w3m-accent'], '#5678ab');
    assert.equal(state.errors, 0);
  });

  test(`sign-out clears ${method} credentials immediately and disconnects AppKit`, async t => {
    const state = await setup(t, provider);
    const signedOut = state.login.signOut();
    assert.equal(state.storage.has(authKey), false);
    assert.equal(state.storage.has(nonceKey), false);
    assert.equal(await state.login.credential(), null);
    await signedOut;
    assert.deepEqual(state.events, ['setSessions', 'ready', 'disconnect']);
    assert.equal(
      state.storage.get('monoid-authority-login:other:auth'),
      'other-project-token',
    );
  });
}

test('new flows erase stale SIWX credentials and disable automatic reconnect', async t => {
  const state = await setup(t, 'email', {signedIn: false});
  assert.equal(state.startupStorage.has(authKey), false);
  assert.equal(state.startupStorage.has(nonceKey), false);
  assert.equal(state.options.enableReconnect, false);
  assert.equal(await state.login.credential(), null);
  assert.ok(state.identities.every(identity => identity === null));
  assert.equal(
    state.storage.get('monoid-authority-login:other:auth'),
    'other-project-token',
  );
});

test('sign-out does not wait for AppKit initialization or embedded-wallet disconnect and is idempotent', async t => {
  const state = await setup(t, 'email');
  let ready, disconnected;
  state.ready = () =>
    new Promise(resolve => {
      ready = resolve;
    });
  state.disconnect = () =>
    new Promise(resolve => {
      disconnected = resolve;
    });
  const pending = state.login.signOut();
  let finished = false;
  void pending.then(() => {
    finished = true;
  });
  assert.equal(state.login.signOut(), pending);
  assert.equal(state.storage.has(authKey), false);
  await flush();
  assert.equal(finished, false);
  assert.deepEqual(state.events, ['setSessions', 'ready']);
  ready();
  await flush();
  assert.equal(finished, false);
  assert.deepEqual(state.events, ['setSessions', 'ready', 'disconnect']);
  disconnected();
  await pending;
  assert.equal(finished, true);
});

test('late SIWX writes and pending verification cannot restore a signed-out account', async t => {
  const state = await setup(t, 'google');
  let resolve;
  state.readProfile = () =>
    new Promise(done => {
      resolve = done;
    });
  const pending = state.login.credential();
  const identitiesBefore = state.identities.length;
  await state.login.signOut();
  state.storage.set(authKey, 'late-token');
  state.storage.set(nonceKey, 'late-nonce');
  state.sessionChanged();
  resolve(state.profile);
  assert.equal(await pending, null);
  assert.equal(state.identities.length, identitiesBefore);
  assert.equal(state.storage.has(authKey), false);
  assert.equal(state.storage.has(nonceKey), false);
});

test('SDK cleanup failures still erase credentials and cannot restore the account', async t => {
  const state = await setup(t, 'email');
  state.setSessions = async () => {
    throw new Error('SIWX cleanup failed');
  };
  state.disconnect = async () => {
    state.storage.set(authKey, 'late-token');
    state.storage.set(nonceKey, 'late-nonce');
    throw new Error('Embedded wallet did not respond');
  };
  await state.login.signOut();
  assert.deepEqual(state.events, ['setSessions', 'ready', 'disconnect']);
  assert.equal(state.storage.has(authKey), false);
  assert.equal(state.storage.has(nonceKey), false);
  assert.equal(await state.login.credential(), null);
});

test('a method change during Continue needs a fresh confirmation, even for the same address and token', async t => {
  const state = await setup(t, 'email');
  let resolve;
  state.readProfile = () =>
    new Promise(done => {
      resolve = done;
    });
  const pending = state.login.credential();
  state.account.embeddedWalletInfo.authProvider = 'github';
  resolve(state.profile);
  assert.equal(await pending, null);
  state.readProfile = async () => state.profile;
  assert.equal(await state.login.credential(), null);
  assert.equal(state.identities.at(-1).method, 'social');
  assert.deepEqual(
    {...(await state.login.credential())},
    {token: 'verified-token', method: 'social', provider: 'github'},
  );
});

test('social-provider changes during Continue require fresh confirmation', async t => {
  const state = await setup(t, 'google');
  let resolve;
  state.readProfile = () =>
    new Promise(done => {
      resolve = done;
    });
  const pending = state.login.credential();
  state.account.embeddedWalletInfo.authProvider = 'github';
  resolve(state.profile);
  assert.equal(await pending, null);
  state.readProfile = async () => state.profile;
  assert.equal(await state.login.credential(), null);
  assert.equal(state.identities.at(-1).provider, 'github');
  assert.deepEqual(
    {...(await state.login.credential())},
    {token: 'verified-token', method: 'social', provider: 'github'},
  );
});

test('unknown embedded providers never become sign-in credentials', async t => {
  const state = await setup(t, 'unknown');
  assert.equal(await state.login.credential(), null);
  assert.equal(state.identities.at(-1), null);
});

test('an embedded account without a verified email never uses its AppKit user email', async t => {
  const state = await setup(t, 'apple');
  delete state.profile.email;
  await state.login.credential();
  assert.equal(state.identities.at(-1).email, undefined);
  assert.equal(state.identities.at(-1).method, 'social');
});

test('account switches and stopping discard pending credentials', async t => {
  const state = await setup(t, 'email');
  let resolve;
  state.readProfile = () =>
    new Promise(done => {
      resolve = done;
    });
  const pending = state.login.credential();
  state.account.caipAddress = 'eip155:1:0x' + 'cd'.repeat(20);
  resolve(state.profile);
  assert.equal(await pending, null);
  state.login.stop();
  assert.equal(await state.login.credential(), null);
});
