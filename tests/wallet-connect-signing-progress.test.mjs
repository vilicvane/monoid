import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {base58} from '@scure/base';

/* eslint-disable @mufan/scoped-modules, @mufan/import -- Load built modules without initializing platform services. */
import {MonoidCardError} from '../.bld/app/@lib/monoid/card-error.js';
import {getAppletKey} from '../.bld/app/@lib/monoid/get-applet-key.js';
import {buildWalletConnectAuthentication} from '../.bld/app/@lib/wallet-connect-authentication.js';
import {parseWalletConnectRequest} from '../.bld/app/@lib/wallet-connect-request.js';
import {
  getKeyWallets,
  matchesWalletReference,
} from '../.bld/app/@services/wallet-storage-service.js';
/* eslint-enable @mufan/scoped-modules, @mufan/import */

let fixture;
const owners = [];
const TOPIC = 'signing-progress-session';
const SOLANA_CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const EVM_PUBLIC_KEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const SECOND_EVM_PUBLIC_KEY =
  '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));

mock.module('react', {
  namedExports: {
    useRef: initial => ({current: initial}),
    useState: initial => [initial, () => {}],
    useEffect: effect => fixture.cleanups.push(effect()),
  },
});
mock.module('react/jsx-runtime', {
  namedExports: {
    jsx: (type, props) => ({type, props}),
    jsxs: (type, props) => ({type, props}),
    Fragment: 'fragment',
  },
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => fixture.entrances},
});
mock.module('../.bld/app/@services/index.js', {
  namedExports: {getKeyWallets, matchesWalletReference},
});
mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {
    MonoidCardError,
    getAppletKey,
    signEvmDigest: (...args) => fixture.sign('evm', ...args),
    signEvmMessage: (...args) => fixture.sign('evm', ...args),
    signSolanaMessage: (...args) => fixture.sign('solana', ...args),
  },
});
mock.module('../.bld/app/@components/@monoid/monoid-scan-prompt.js', {
  namedExports: {
    MonoidScanStatePromptProgress: 'progress',
    useMonoidScanPrompt: () => [null, fixture.scan],
  },
});
mock.module('../.bld/app/@components/@ui/button.js', {
  namedExports: {AsyncButton: 'button'},
});

const {WalletConnectSignButton} = await import(
  '../.bld/app/@components/views/@sessions/wallet-connect-sign-button.js'
);
const {WalletConnectApproveButton} = await import(
  '../.bld/app/@components/views/@scan/wallet-connect-approve-button.js'
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return {promise, resolve, reject};
}

function nativeKey(type, index, publicKey) {
  return {
    type,
    index,
    alias: undefined,
    wallets: [
      {
        addressType: type === 'ed25519' ? 'solana' : 'evm',
        publicKey,
        seed: undefined,
        curve: undefined,
        path: undefined,
      },
    ],
  };
}

function solanaTransaction(publicKey, blockhashByte) {
  // One signer, a blockhash, and no instructions; both requests remain distinct.
  return Buffer.from([
    1,
    ...new Uint8Array(64),
    1,
    0,
    0,
    1,
    ...bytes(publicKey),
    ...new Uint8Array(32).fill(blockhashByte),
    0,
  ]).toString('base64');
}

function mount(kind, {separateCards = false} = {}) {
  const solana = kind.startsWith('solana');
  const keys = [
    solana
      ? nativeKey('ed25519', '04010000000000000001', '01'.repeat(32))
      : nativeKey('secp256k1', '03010000000000000001', EVM_PUBLIC_KEY),
  ];
  if (kind === 'authentication' && separateCards) {
    keys.push(
      nativeKey('secp256k1', '03010000000000000002', SECOND_EVM_PUBLIC_KEY),
    );
  }
  const addresses = keys.map(key => getKeyWallets(key)[0].address);
  const state = {
    keys,
    addresses,
    cleanups: [],
    scans: [],
    signatures: [],
    responses: [],
    states: [],
    completions: 0,
    resets: 0,
    view: {id: 1, $leaving: false, $match: {$exact: {$active: true}}},
  };
  const service = {
    requests: new Map(),
    sessions: new Map(),
    proposals: new Map(),
    getTransactionSubmission: () => undefined,
    getSolanaTransactionSubmission: () => undefined,
    approveRequest: async (...args) => {
      state.responses.push(args);
      return true;
    },
    approveSolanaTransactionRequest: async (...args) => {
      state.responses.push(args);
      return true;
    },
    approve: async (...args) => {
      state.responses.push(args);
      return {topic: TOPIC};
    },
  };
  state.entrances = {
    walletKit: {core: {projectId: 'progress-tests'}},
    walletKitService: service,
    walletStorageService: {keys},
    router: {sessions: {$reset: () => state.resets++}},
  };
  state.sign = (type, applet, reference, message, address, assertCurrent) => {
    assertCurrent();
    const signature = {...deferred(), type, reference, message, address};
    state.signatures.push(signature);
    return signature.promise;
  };
  state.scan = async (label, callback) => {
    const scan = {label, contents: [], controller: new AbortController()};
    const cardKeys = separateCards ? [keys[state.scans.length]] : keys;
    state.scans.push(scan);
    await callback(
      {
        list: async () => ({
          items: cardKeys.map(key => ({index: bytes(key.index)})),
        }),
      },
      content => scan.contents.push(content),
      {},
      scan.controller.signal,
    );
  };
  state.resolveSignature = async () => {
    const signature = state.signatures.at(-1);
    signature.resolve(
      signature.type === 'solana'
        ? base58.encode(new Uint8Array(64).fill(state.signatures.length))
        : `0x${'01'.repeat(65)}`,
    );
    await setImmediate();
  };

  fixture = state;
  const common = {
    view: state.view,
    disabled: false,
    onStateChange: value => state.states.push(value),
  };
  if (kind === 'authentication') {
    const authentication = {
      type: 'caip122',
      version: '1',
      domain: 'example.com',
      aud: 'https://example.com/login',
      nonce: 'progress123',
      iat: new Date().toISOString(),
      chains: ['eip155:1'],
    };
    const proposal = {
      id: 1,
      params: {
        expiryTimestamp: Math.floor(Date.now() / 1000) + 3600,
        requiredNamespaces: {},
        optionalNamespaces: {
          eip155: {chains: ['eip155:1'], methods: [], events: []},
        },
        requests: {
          authentication: separateCards
            ? [authentication]
            : [authentication, {...authentication, nonce: 'another123'}],
        },
      },
    };
    service.proposals.set(1, proposal);
    state.view.addresses = addresses;
    state.view.authentication = buildWalletConnectAuthentication(
      proposal,
      addresses,
    );
    state.tree = WalletConnectApproveButton({...common, proposal});
  } else {
    const chainId = solana ? SOLANA_CHAIN : 'eip155:1';
    const method =
      kind === 'solana-batch'
        ? 'solana_signAllTransactions'
        : solana
          ? 'solana_signMessage'
          : 'personal_sign';
    const params =
      kind === 'solana-batch'
        ? {
            transactions: [1, 2].map(value =>
              solanaTransaction(keys[0].wallets[0].publicKey, value),
            ),
          }
        : solana
          ? {
              pubkey: addresses[0],
              message: base58.encode(new TextEncoder().encode('Hello')),
            }
          : ['0x48656c6c6f', addresses[0]];
    const request = {
      id: 1,
      topic: TOPIC,
      params: {chainId, request: {method, params}},
    };
    const session = {
      topic: TOPIC,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      namespaces: {
        [solana ? 'solana' : 'eip155']: {
          chains: [chainId],
          accounts: addresses.map(address => `${chainId}:${address}`),
          methods: [method],
          events: [],
        },
      },
    };
    service.requests.set(1, request);
    service.sessions.set(TOPIC, session);
    state.tree = WalletConnectSignButton({
      ...common,
      topic: TOPIC,
      payload: parseWalletConnectRequest(request, session),
      selectedAddresses:
        kind === 'solana-batch' ? [addresses[0], addresses[0]] : [],
      color: 'primary',
      onComplete: async () => state.completions++,
    });
  }
  state.start = async () => {
    state.finished = state.tree.props.children[0].props.handler();
    // Some tests reject delayed card work before awaiting the whole button handler.
    state.finished.catch(() => {});
    await setImmediate();
  };
  owners.push(state);
  return state;
}

function progress(state) {
  return state.scans
    .flatMap(scan => scan.contents)
    .map(content => {
      assert.equal(content.type, 'progress');
      assert.equal(content.props.children, 'Signing');
      return [content.props.current, content.props.total];
    });
}

afterEach(() =>
  owners
    .splice(0)
    .forEach(state => state.cleanups.forEach(cleanup => cleanup?.())),
);

for (const kind of ['evm-message', 'solana-message']) {
  test(`${kind} stays at 0/1 until the signature completes`, async () => {
    const state = mount(kind);
    await state.start();
    assert.equal(state.signatures.length, 1);
    assert.deepEqual(progress(state), [[0, 1]]);
    assert.deepEqual(state.responses, []);

    await state.resolveSignature();
    await state.finished;
    assert.deepEqual(progress(state), [
      [0, 1],
      [1, 1],
    ]);
    assert.equal(state.responses.length, 1);
    assert.equal(state.completions, 1);
  });
}

for (const kind of ['solana-batch', 'authentication']) {
  test(`${kind} reports completed signatures while the next signature is pending`, async () => {
    const state = mount(kind);
    await state.start();
    assert.deepEqual(progress(state), [[0, 2]]);

    await state.resolveSignature();
    assert.equal(state.signatures.length, 2);
    assert.deepEqual(progress(state).at(-1), [1, 2]);
    assert.ok(progress(state).every(([current]) => current <= 1));
    assert.deepEqual(state.responses, []);

    await state.resolveSignature();
    await state.finished;
    assert.deepEqual(progress(state).at(-1), [2, 2]);
    assert.equal(state.responses.length, 1);
    assert.equal(
      kind === 'authentication' ? state.resets : state.completions,
      1,
    );
  });

  test(`${kind} does not count a failed second signature as complete`, async () => {
    const state = mount(kind);
    await state.start();
    await state.resolveSignature();
    const before = progress(state);
    state.signatures.at(-1).reject(new Error('Card was removed'));
    await assert.rejects(state.finished, /Card was removed/);

    assert.deepEqual(progress(state), before);
    assert.deepEqual(progress(state).at(-1), [1, 2]);
    assert.deepEqual(state.responses, []);
    assert.equal(state.resets + state.completions, 0);
  });
}

for (const kind of [
  'evm-message',
  'solana-message',
  'solana-batch',
  'authentication',
]) {
  test(`${kind} suppresses late progress and responses after scan cancellation`, async () => {
    const state = mount(kind);
    await state.start();
    if (kind === 'solana-batch' || kind === 'authentication') {
      await state.resolveSignature();
    }
    const before = progress(state);
    state.scans.at(-1).controller.abort();
    await state.resolveSignature();
    await assert.rejects(state.finished);

    assert.deepEqual(progress(state), before);
    assert.deepEqual(state.responses, []);
    assert.equal(state.resets + state.completions, 0);
  });
}

test('authentication carries completed count to the next card', async () => {
  const state = mount('authentication', {separateCards: true});
  await state.start();
  assert.deepEqual(progress(state), [[0, 2]]);
  await state.resolveSignature();
  assert.equal(state.scans.length, 2);
  assert.equal(state.scans[1].label, 'Scan next card to sign in');
  assert.equal(state.scans[1].contents[0].props.current, 1);
  assert.deepEqual(state.responses, []);

  await state.resolveSignature();
  await state.finished;
  assert.deepEqual(progress(state).at(-1), [2, 2]);
  assert.equal(state.responses[0][2].length, 2);
  assert.equal(state.resets, 1);
});
