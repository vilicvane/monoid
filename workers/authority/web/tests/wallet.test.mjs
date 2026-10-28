import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {test} from 'node:test';
import {createContext, SourceTextModule, SyntheticModule} from 'node:vm';

const source = stripTypeScriptTypes(
  await readFile(new URL('../src/wallet.ts', import.meta.url), 'utf8'),
);
const address = '0x' + 'ab'.repeat(20);
const account = {
  source: 'wallet',
  id: 'eip155:' + address,
  displayName: address,
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return {promise, resolve};
};

async function setup(t) {
  const state = {
    calls: [],
    events: [],
    identities: [],
    errors: 0,
    ready: async () => {},
    disconnect: async () => {},
  };
  const challenge = {
    message: 'Worker-issued SIWE',
    data: {
      accountAddress: address,
      chainId: 'eip155:1',
      nonce: 'worker-nonce',
      expirationTime: new Date(Date.now() + 900000).toISOString(),
    },
  };
  state.request = async path =>
    path === 'wallet/nonce' ? challenge : {account};
  const appkit = {
    subscribeAccount: callback => {
      state.accountChanged = callback;
      return () => state.events.push('unsubscribe');
    },
    ready: () => state.ready(),
    disconnect: () => {
      state.events.push('disconnect');
      return state.disconnect();
    },
    close: async () => {
      state.events.push('close');
    },
    open: async () => {
      state.events.push('open');
    },
    updateRemoteFeatures: features => {
      state.remote = features;
      state.events.push('features');
    },
    updateOptions: options => {
      state.activeSiwx = options.siwx;
      state.events.push('options');
    },
  };
  const context = createContext({
    location: {origin: 'https://authority.test'},
    document: {documentElement: {}},
    getComputedStyle: () => ({
      getPropertyValue: name =>
        name === '--ion-color-primary' ? ' #5678ab ' : ' system-ui ',
    }),
  });
  const dependencies = {
    '@reown/appkit': {
      createAppKit: options => {
        state.options = options;
        return appkit;
      },
    },
    '@reown/appkit-adapter-ethers': {EthersAdapter: class {}},
    '@reown/appkit/networks': {mainnet: {}},
  };
  const module = new SourceTextModule(source, {context});
  await module.link(specifier => {
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
  state.login = module.namespace.createWalletLogin(
    'project',
    {
      flow: 'flow-id',
      request: async (path, input) => {
        state.calls.push({path, input});
        return state.request(path, input);
      },
    },
    value => state.identities.push(value),
    () => state.errors++,
  );
  state.siwx = state.options.siwx;
  state.session = {
    data: challenge.data,
    message: challenge.message,
    signature: '0xsigned',
  };
  t.after(() => state.login.stop());
  return state;
}

test('wallet-only configuration restores the Worker verifier after dashboard initialization', async t => {
  const s = await setup(t);
  await s.login.open();
  assert.equal(s.options.enableReconnect, false);
  assert.equal(s.options.features.email, false);
  assert.equal(s.options.features.socials, false);
  assert.equal(s.options.features.reownAuthentication, false);
  assert.equal(s.remote.emailCapture, false);
  assert.equal(s.remote.reownAuthentication, false);
  assert.equal(s.activeSiwx, s.siwx);
  assert.deepEqual(s.events, ['features', 'options', 'open']);
  assert.equal(s.options.themeVariables['--w3m-accent'], '#5678ab');
  assert.equal(s.siwx.getRequired(), true);
});

test('SIWX uses the Worker challenge and only exposes a verified session', async t => {
  const s = await setup(t);
  s.accountChanged({isConnected: true, caipAddress: 'eip155:1:' + address});
  const message = await s.siwx.createMessage({
    accountAddress: address,
    chainId: 'eip155:1',
  });
  assert.equal(message.toString(), s.session.message);
  assert.equal((await s.siwx.getSessions('eip155:1', address)).length, 0);
  await s.siwx.addSession(s.session);
  assert.deepEqual(s.identities, [account]);
  assert.equal(
    (await s.siwx.getSessions('eip155:1', address.toUpperCase())).length,
    1,
  );
  assert.equal((await s.siwx.getSessions('eip155:10', address)).length, 0);
  assert.equal((await s.siwx.getSessions('eip155:1', '0xother')).length, 0);
  s.session.data.expirationTime = '2000-01-01T00:00:00.000Z';
  assert.equal((await s.siwx.getSessions('eip155:1', address)).length, 0);
});

test('WalletConnect can request metadata before it knows the address and then authenticate', async t => {
  const s = await setup(t),
    original = s.request;
  s.request = async (path, input) =>
    path === 'wallet/nonce'
      ? {data: {...s.session.data, accountAddress: ''}}
      : original(path, input);
  const message = await s.siwx.createMessage({
    accountAddress: '',
    chainId: 'eip155:1',
  });
  assert.equal(message.nonce, 'worker-nonce');
  assert.throws(() => message.toString(), /Wallet address required/);
  await s.siwx.setSessions([s.session]);
  s.accountChanged({isConnected: true, caipAddress: 'eip155:1:' + address});
  assert.deepEqual(s.identities, [account]);
  assert.equal((await s.siwx.getSessions('eip155:1', address)).length, 1);
});

test('failed verification, wrong source/address/chain and multiple accounts never become sessions', async t => {
  const s = await setup(t);
  for (const response of [
    new Error('Rejected'),
    {account: {...account, source: 'google'}},
    {account: {...account, id: 'eip155:other'}},
  ]) {
    s.request = async () => {
      if (response instanceof Error) throw response;
      return response;
    };
    await assert.rejects(s.siwx.addSession(s.session));
  }
  s.request = async () => ({account});
  await assert.rejects(
    s.siwx.addSession({
      ...s.session,
      data: {...s.session.data, chainId: 'eip155:10'},
    }),
  );
  await assert.rejects(s.siwx.setSessions([s.session, s.session]));
  assert.equal(s.identities.length, 0);
});

test('account changes invalidate pending proofs and reset the Worker flow before a new challenge', async t => {
  const s = await setup(t),
    waiting = deferred(),
    original = s.request;
  s.accountChanged({isConnected: true, caipAddress: 'eip155:1:' + address});
  s.request = (path, input) =>
    path === 'wallet/verify' ? waiting.promise : original(path, input);
  const pending = s.siwx.addSession(s.session);
  s.accountChanged({
    isConnected: true,
    caipAddress: 'eip155:1:0x' + 'cd'.repeat(20),
  });
  await flush();
  waiting.resolve({account});
  await assert.rejects(pending, /Account changed/);
  assert.deepEqual(s.identities, [null]);
  assert.ok(s.calls.some(call => call.path === 'reset'));
});

test('cancel/sign-out clears memory immediately, ignores late work, and does not wait for disconnect', async t => {
  const s = await setup(t),
    waiting = deferred(),
    ready = deferred();
  s.request = () => waiting.promise;
  const pending = s.siwx.addSession(s.session);
  s.ready = () => ready.promise;
  const signingOut = s.login.signOut();
  assert.equal(s.login.signOut(), signingOut);
  assert.equal((await s.siwx.getSessions('eip155:1', address)).length, 0);
  assert.equal(s.events.includes('disconnect'), false);
  waiting.resolve({account});
  await assert.rejects(pending, /Account changed/);
  assert.equal(s.identities.length, 0);
  ready.resolve();
  await signingOut;
  assert.equal(s.events.includes('disconnect'), true);
  await assert.rejects(
    s.siwx.createMessage({accountAddress: address, chainId: 'eip155:1'}),
    /Sign-in ended/,
  );
});

test('a late nonce is discarded and changing providers drains it before reset/navigation', async t => {
  const s = await setup(t),
    waiting = deferred();
  s.request = () => waiting.promise;
  const pending = s.siwx.createMessage({
    accountAddress: address,
    chainId: 'eip155:1',
  });
  await flush();
  const changing = s.login.changeAccount();
  await flush();
  assert.equal(s.events.includes('disconnect'), false);
  waiting.resolve({message: s.session.message, data: s.session.data});
  await assert.rejects(pending, /Account changed/);
  await changing;
  assert.equal(s.events.includes('disconnect'), true);
});

test('revocation clears cached identity and a later reset can recover after a network failure', async t => {
  const s = await setup(t);
  await s.siwx.addSession(s.session);
  s.request = async () => {
    throw new Error('Offline');
  };
  await assert.rejects(s.siwx.revokeSession());
  assert.equal((await s.siwx.getSessions('eip155:1', address)).length, 0);
  s.request = async () => ({account: null});
  await s.siwx.setSessions([]);
  assert.equal(s.calls.filter(call => call.path === 'reset').length, 2);
});
