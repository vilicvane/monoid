import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

import {observable, runInAction} from 'mobx';
import {routra} from 'routra';

// eslint-disable-next-line @mufan/scoped-modules -- Exercise the app's routes without initializing platform services.
import {ROUTE_SCHEMA} from '../.bld/app/@routes.js';

let entrances;
let dispose;

mock.module('react', {
  namedExports: {
    useEffect: effect => {
      dispose = effect();
    },
  },
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => entrances},
});

const {WalletConnectRequests} = await import(
  '../.bld/app/@components/wallet-connect-requests.js'
);

function fixture(context) {
  const state = observable({requestMatched: false});
  const route = () => {
    const value = observable({
      $matched: false,
      $transition: false,
      $switching: false,
      entries: [],
    });
    value.$view = () => ({$entries: value.$matched ? value.entries : []});
    return value;
  };
  const pushed = [];
  const request = ({id}) => ({
    $push: () => {
      pushed.push(id);
      return Promise.resolve();
    },
  });
  Object.defineProperty(request, '$matched', {
    get: () => state.requestMatched,
  });
  const sessions = route();
  Object.defineProperty(sessions, 'request', {value: request});
  sessions.transaction = route();
  sessions.solanaTransaction = route();
  const ethereum = Object.assign(route(), {
    wallet: Object.assign(route(), {
      transaction: Object.assign(route(), {replace: route()}),
    }),
  });
  const requests = observable.map();
  const responding = observable.set();
  entrances = {
    router: {
      $path: 'features',
      features: route(),
      bitcoin: Object.assign(route(), {
        wallet: Object.assign(route(), {send: route()}),
      }),
      sessions,
      ethereum,
      solana: Object.assign(route(), {
        wallet: Object.assign(route(), {transaction: route()}),
      }),
      scan: Object.assign(route(), {connection: route()}),
      safe: route(),
    },
    walletKitService: {
      requests,
      isRespondingToRequest: id => responding.has(id),
    },
    monoidScanPromptPresenter: observable({current: null}),
    keyboard: observable({shown: false}),
  };
  context.after(() => dispose?.());
  return {...entrances, requests, responding, pushed, state};
}

test('a settled feature hub presents a new request once', context => {
  const {requests, pushed, keyboard} = fixture(context);
  assert.equal(WalletConnectRequests(), null);
  runInAction(() => requests.set(1, {id: 1}));
  assert.deepEqual(pushed, [1]);

  runInAction(() => {
    keyboard.shown = true;
  });
  runInAction(() => {
    keyboard.shown = false;
  });
  assert.deepEqual(pushed, [1]);
});

for (const feature of ['features', 'ethereum', 'solana', 'bitcoin']) {
  for (const transition of ['$transition', '$switching']) {
    test(`${feature} ${transition} delays automatic request navigation until settled`, context => {
      const {router, requests, pushed} = fixture(context);
      runInAction(() => {
        router[feature][transition] = true;
        requests.set(1, {id: 1});
      });
      WalletConnectRequests();
      assert.deepEqual(pushed, []);

      runInAction(() => {
        router[feature][transition] = false;
      });
      assert.deepEqual(pushed, [1]);
    });
  }
}

for (const feature of ['ethereum', 'solana', 'bitcoin']) {
  test(`browsing ${feature} allows new requests to open`, context => {
    const {router, requests, pushed} = fixture(context);
    runInAction(() => {
      router[feature].$matched = true;
    });
    WalletConnectRequests();
    runInAction(() => requests.set(1, {id: 1}));
    assert.deepEqual(pushed, [1]);
    runInAction(() => {
      router[feature].$matched = false;
    });
    assert.deepEqual(pushed, [1]);

    runInAction(() => requests.set(2, {id: 2}));
    assert.deepEqual(pushed, [1, 2]);
  });
}

test('bitcoin send review keeps incoming requests manual after returning to the wallet', context => {
  const {router, requests, pushed} = fixture(context);
  runInAction(() => {
    router.bitcoin.$matched = true;
    router.bitcoin.wallet.send.$matched = true;
  });
  WalletConnectRequests();
  runInAction(() => {
    requests.set(1, {id: 1});
    requests.set(2, {id: 2});
  });
  assert.deepEqual(pushed, []);
  runInAction(() => {
    router.bitcoin.wallet.send.$matched = false;
  });
  assert.deepEqual(pushed, []);
  runInAction(() => requests.set(3, {id: 3}));
  assert.deepEqual(pushed, [3]);
});

test('Ethereum speed up and cancel review keep new requests queued', context => {
  const {router, requests, pushed} = fixture(context);
  runInAction(() => {
    router.ethereum.$matched = true;
    router.ethereum.wallet.transaction.replace.$matched = true;
  });
  WalletConnectRequests();
  runInAction(() => requests.set(1, {id: 1}));
  assert.deepEqual(pushed, []);
  runInAction(() => {
    router.ethereum.wallet.transaction.replace.$matched = false;
  });
  assert.deepEqual(pushed, []);
  runInAction(() => requests.set(2, {id: 2}));
  assert.deepEqual(pushed, [2]);
});

for (const feature of ['ethereum', 'solana']) {
  test(`${feature} request navigation waits for an actual cancelled back gesture`, async context => {
    const {requests} = fixture(context);
    const router = routra(ROUTE_SCHEMA, {});
    entrances.router = router;
    await router.features.$reset().$completed;
    await router[feature].$push().$completed;
    await router[feature].wallet({address: 'wallet-address'}).$push()
      .$completed;
    WalletConnectRequests();

    const swipe = router.$back.$switch({progress: 0.4});
    runInAction(() => requests.set(1, {id: 1}));
    assert.equal(router.sessions.request.$matched, false);
    assert.equal(router[feature].wallet.$exact.$active, true);

    swipe.$abort();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(router.sessions.request.$exact.$active, true);
    assert.equal(router.$state.id, 1);

    await router.$back().$completed;
    assert.equal(router[feature].wallet.$exact.$active, true);
    assert.deepEqual({...router.$state}, {address: 'wallet-address'});
  });
}

for (const kind of ['speed-up', 'cancel']) {
  test(`actual Ethereum ${kind} review keeps incoming requests manual on exit`, async context => {
    const {requests} = fixture(context);
    const router = routra(ROUTE_SCHEMA, {});
    entrances.router = router;
    await router.ethereum
      .wallet({address: 'wallet-address'})
      .transaction({chainId: 'eip155:1', hash: 'transaction-hash'})
      .$reset().$completed;
    await router.ethereum.wallet.transaction.replace({kind}).$push().$completed;
    WalletConnectRequests();

    runInAction(() => requests.set(1, {id: 1}));
    assert.equal(router.sessions.request.$matched, false);
    await router.$back().$completed;
    assert.equal(router.ethereum.wallet.transaction.$exact.$active, true);
    assert.equal(router.sessions.request.$matched, false);

    runInAction(() => requests.set(2, {id: 2}));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(router.sessions.request.$exact.$active, true);
    assert.equal(router.$state.id, 2);
  });
}

test('requests received during review remain manual after reaching the result', context => {
  const {router, requests, state, pushed} = fixture(context);
  runInAction(() => {
    state.requestMatched = true;
  });
  WalletConnectRequests();
  runInAction(() => requests.set(1, {id: 1}));
  runInAction(() => {
    state.requestMatched = false;
    router.sessions.transaction.$matched = true;
  });
  runInAction(() => {
    router.sessions.transaction.$matched = false;
  });
  assert.deepEqual(pushed, []);
});

for (const result of ['transaction', 'solanaTransaction']) {
  test(`${result} allows a new request without reopening its own pending response`, context => {
    const {router, requests, pushed} = fixture(context);
    runInAction(() => {
      router.sessions[result].$matched = true;
      router.sessions[result].entries = [{id: 1}];
      requests.set(1, {id: 1});
    });
    WalletConnectRequests();
    assert.deepEqual(pushed, []);

    runInAction(() => requests.set(2, {id: 2}));
    assert.deepEqual(pushed, [2]);
  });

  test(`requests arriving during the transition to ${result} open after it settles`, context => {
    const {router, requests, state, pushed} = fixture(context);
    runInAction(() => {
      state.requestMatched = true;
      requests.set(1, {id: 1});
    });
    WalletConnectRequests();
    runInAction(() => {
      router.sessions.$transition = true;
      router.sessions[result].$matched = true;
      router.sessions[result].entries = [{id: 1}];
      requests.set(2, {id: 2});
    });
    assert.deepEqual(pushed, []);
    runInAction(() => {
      state.requestMatched = false;
      router.sessions.$transition = false;
    });
    assert.deepEqual(pushed, [2]);
  });
}

test('connection, card prompt and keyboard delay new requests on a result page', context => {
  const {router, requests, pushed, monoidScanPromptPresenter, keyboard} =
    fixture(context);
  runInAction(() => {
    router.sessions.solanaTransaction.$matched = true;
    router.scan.connection.$matched = true;
    monoidScanPromptPresenter.current = {};
    keyboard.shown = true;
  });
  WalletConnectRequests();
  runInAction(() => requests.set(1, {id: 1}));
  assert.deepEqual(pushed, []);
  runInAction(() => {
    router.scan.connection.$matched = false;
    monoidScanPromptPresenter.current = null;
  });
  assert.deepEqual(pushed, []);
  runInAction(() => {
    keyboard.shown = false;
  });
  assert.deepEqual(pushed, [1]);
});

test('unmount disposes the request observer', context => {
  const {requests, pushed} = fixture(context);
  WalletConnectRequests();
  dispose();
  runInAction(() => requests.set(1, {id: 1}));
  assert.deepEqual(pushed, []);
});
