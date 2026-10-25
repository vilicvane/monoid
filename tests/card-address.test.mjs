import assert from 'node:assert/strict';
import {test} from 'node:test';

import {getBytes} from 'ethers';

import {
  getCardKeyAddressTypes,
  getLocalCardKeyAddress,
  getLocalCardWalletDerivation,
  readCardKeyAddress,
  readCardWalletDerivations,
} from '../.bld/app/@components/views/safe/card-address.js';
import {
  encodeCardDerivationRecord,
  getCardDerivationItemIndex,
} from '../.bld/app/@components/views/safe/card-derivations.js';
import {isCardKeyItem} from '../.bld/app/@components/views/safe/common.js';
import {scanCardItems} from '../.bld/app/@components/views/safe/scan-card.js';
import {parseDerivationPath} from '../.bld/app/@lib/bip39.js';
import {
  CBORAppletError,
  CardItemNotFoundError,
} from '../.bld/app/@lib/cbor-applet.js';
import {createMonoidApplet} from '../.bld/app/@lib/monoid/monoid-applet.js';
import {WalletKeyKnownType} from '../.bld/app/@services/wallet-storage-service.js';

const INDEX = '00000001';
const PUBLIC_KEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const P256_PUBLIC_KEY =
  '036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296';
const TAPROOT_KEY =
  'a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c';
const EVM_ADDRESS = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const SEGWIT_ADDRESS = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const TAPROOT_ADDRESS =
  'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
const bytes = hex => getBytes(`0x${hex}`);

const PRESETS = [
  ['evm', 'secp256k1', "m/44'/60'/0'/0/0", PUBLIC_KEY, EVM_ADDRESS],
  ['solana', 'ed25519', "m/44'/501'/0'/0'", '00'.repeat(32), '1'.repeat(32)],
  [
    'bitcoin-segwit',
    'secp256k1',
    "m/84'/0'/0'/0/0",
    PUBLIC_KEY,
    SEGWIT_ADDRESS,
  ],
  [
    'bitcoin-taproot',
    'secp256k1',
    "m/86'/0'/0'/0/0",
    TAPROOT_KEY,
    TAPROOT_ADDRESS,
  ],
];

test('card key address choices match the key capabilities', () => {
  const all = ['evm', 'solana', 'bitcoin-segwit', 'bitcoin-taproot'];
  assert.deepEqual(getCardKeyAddressTypes('seed'), all);
  assert.deepEqual(getCardKeyAddressTypes('master'), []);
  assert.deepEqual(getCardKeyAddressTypes('secp256k1'), [
    'evm',
    'bitcoin-segwit',
    'bitcoin-taproot',
  ]);
  assert.deepEqual(getCardKeyAddressTypes('ed25519'), ['solana']);
  assert.deepEqual(getCardKeyAddressTypes('secp256r1'), []);
  assert.deepEqual(getCardKeyAddressTypes('unknown'), []);
  assert.equal(WalletKeyKnownType.is('ed25519'), true);
});

test('seed addresses use their preset path and request a fresh public key', async () => {
  for (const [addressType, curve, path, publicKey, address] of PRESETS) {
    const requests = [];
    const applet = {
      async viewKey(request) {
        requests.push(request);
        return {publicKey: bytes(publicKey)};
      },
    };
    const ref = await readCardKeyAddress(
      applet,
      {type: 'seed', index: INDEX},
      addressType,
    );
    const seed = curve === 'ed25519' ? 'ed25519 seed' : 'Bitcoin seed';

    assert.deepEqual(requests, [
      {
        type: 'seed',
        index: bytes(INDEX),
        derivation: {
          type: curve === 'ed25519' ? 'slip10' : 'bip32',
          ...(curve === 'ed25519' && {curve}),
          path: parseDerivationPath(path),
        },
        ...(addressType === 'bitcoin-taproot' && {taproot: true}),
      },
    ]);
    assert.deepEqual(ref, {
      addressType,
      seed,
      curve,
      path,
      publicKey,
      address,
    });
  }
});

test('raw keys omit all derivation options, while raw Taproot still requests a tweak', async () => {
  for (const [addressType, curve, , publicKey, address] of PRESETS) {
    const requests = [];
    const applet = {
      async viewKey(request) {
        requests.push(request);
        return {publicKey: bytes(publicKey)};
      },
    };
    const ref = await readCardKeyAddress(
      applet,
      {type: curve, index: INDEX},
      addressType,
    );

    assert.deepEqual(requests, [
      {
        type: curve,
        index: bytes(INDEX),
        ...(addressType === 'bitcoin-taproot' && {taproot: true}),
      },
    ]);
    assert.deepEqual(ref, {addressType, publicKey, address});
  }
});

test('the applet schema preserves the raw Taproot flag without curve or path', async () => {
  const applet = createMonoidApplet(new Uint8Array([1]));
  const requests = [];
  applet.sendCommand = async (...request) => {
    requests.push(request);
    return {publicKey: bytes(TAPROOT_KEY)};
  };

  await readCardKeyAddress(
    applet,
    {type: 'secp256k1', index: INDEX},
    'bitcoin-taproot',
  );

  assert.deepEqual(requests, [
    [0x40, {type: 'secp256k1', index: bytes(INDEX), taproot: true}],
  ]);
});

test('unsupported selections reject before talking to the card', async () => {
  const applet = {viewKey: () => assert.fail('Unexpected card request')};

  for (const [type, addressType] of [
    ['ed25519', 'evm'],
    ['ed25519', 'bitcoin-taproot'],
    ['secp256k1', 'solana'],
    ['secp256r1', 'evm'],
    ['unknown', 'evm'],
    ['master', 'evm'],
    ['master', 'solana'],
  ]) {
    await assert.rejects(
      readCardKeyAddress(applet, {type, index: INDEX}, addressType),
      /not supported/,
    );
  }
});

test('local conversion reuses ordinary raw public keys and never reinterprets a tweaked key', () => {
  const evm = {
    addressType: 'evm',
    publicKey: PUBLIC_KEY,
    address: EVM_ADDRESS,
  };
  const segwit = {
    ...evm,
    addressType: 'bitcoin-segwit',
    address: SEGWIT_ADDRESS,
  };
  const taproot = {
    addressType: 'bitcoin-taproot',
    publicKey: TAPROOT_KEY,
    address: TAPROOT_ADDRESS,
  };

  assert.equal(getLocalCardKeyAddress(evm, 'evm'), evm);
  assert.deepEqual(getLocalCardKeyAddress(evm, 'bitcoin-segwit'), segwit);
  assert.deepEqual(getLocalCardKeyAddress(segwit, 'evm'), evm);
  assert.equal(getLocalCardKeyAddress(taproot, 'bitcoin-taproot'), taproot);

  for (const [ref, target] of [
    [evm, 'bitcoin-taproot'],
    [evm, 'solana'],
    [taproot, 'evm'],
    [taproot, 'bitcoin-segwit'],
    [taproot, 'solana'],
    [{...evm, path: "m/44'/60'/0'/0/0"}, 'bitcoin-segwit'],
  ]) {
    assert.equal(getLocalCardKeyAddress(ref, target), undefined);
  }
});

test('card scans retain metadata, wallet addresses and native P-256 public keys separately', async () => {
  const walletTypes = ['seed', 'secp256k1', 'ed25519'];
  const items = walletTypes.map((type, index) => ({
    type,
    index: new Uint8Array([index + 1]),
    alias: `Key ${index}`,
    secret: index % 2 === 0,
  }));
  items.push(
    {
      type: 'entropy',
      index: new Uint8Array([5]),
      metadata: new Uint8Array(),
      alias: '',
      secret: true,
    },
    {
      type: 'secp256r1',
      index: new Uint8Array([6]),
      metadata: bytes('abcd'),
      secret: false,
    },
    {
      type: 'note',
      index: new Uint8Array([7]),
      metadata: new Uint8Array(),
      alias: '',
      secret: false,
    },
    {type: 'unknown', index: new Uint8Array([8]), secret: true},
    {
      type: 123,
      index: new Uint8Array([9]),
      metadata: bytes('00'),
      secret: false,
    },
    {index: new Uint8Array([10]), secret: true},
  );
  const requests = [];
  const progress = [];
  const applet = {
    async list() {
      return {items};
    },
    async viewKey(request) {
      requests.push(request);
      return {
        publicKey:
          request.type === 'secp256r1'
            ? bytes(P256_PUBLIC_KEY)
            : request.type === 'ed25519'
              ? new Uint8Array(32)
              : bytes(PUBLIC_KEY),
      };
    },
  };

  const scanned = await scanCardItems(applet, (...value) =>
    progress.push(value),
  );

  assert.deepEqual(progress, [
    [0, 4, 'keys'],
    [1, 4, 'keys'],
    [2, 4, 'keys'],
    [3, 4, 'keys'],
    [4, 4, 'keys'],
  ]);
  assert.equal(scanned.length, items.length);
  for (const [position, item] of items.entries()) {
    const {ref, publicKey, derivations, ...metadata} = scanned[position];
    assert.equal(
      publicKey,
      item.type === 'secp256r1' ? P256_PUBLIC_KEY : undefined,
    );
    assert.deepEqual(derivations, item.type === 'seed' ? [] : undefined);
    assert.deepEqual(metadata, {
      index: Buffer.from(item.index).toString('hex'),
      ...(item.type !== undefined && {type: item.type}),
      ...(item.alias !== undefined && {alias: item.alias}),
      ...(item.metadata !== undefined && {
        metadata: Buffer.from(item.metadata).toString('hex'),
      }),
      secret: item.secret,
    });
    if (position >= walletTypes.length) assert.equal(ref, undefined);
  }
  assert.deepEqual(
    scanned.slice(0, 3).map(key => key.ref.addressType),
    ['evm', 'evm', 'solana'],
  );
  assert.deepEqual(scanned[2], {
    type: 'ed25519',
    index: '03',
    alias: 'Key 2',
    secret: true,
    ref: {
      addressType: 'solana',
      publicKey: '00'.repeat(32),
      address: '1'.repeat(32),
    },
  });
  assert.deepEqual(requests[2], {
    type: 'ed25519',
    index: new Uint8Array([3]),
  });
  assert.deepEqual(requests[3], {
    type: 'secp256r1',
    index: new Uint8Array([6]),
  });
  assert.equal(requests.length, 4);
});

test('initial scans retain unsupported wallet keys without an address but propagate other errors', async () => {
  const items = ['seed', 'ed25519'].map((type, index) => ({
    type,
    index: new Uint8Array([index + 1]),
    metadata: new Uint8Array(),
    alias: '',
    secret: true,
  }));
  const progress = [];
  const applet = {
    async list() {
      return {items};
    },
    async viewKey({index}) {
      if (index[0] === 1) {
        throw new CBORAppletError({code: 'UNSUPPORTED_SEED_LENGTH'});
      }
      return {publicKey: new Uint8Array(32)};
    },
  };

  const scanned = await scanCardItems(applet, (...value) =>
    progress.push(value),
  );
  assert.deepEqual(
    scanned.map(item => item.type),
    ['seed', 'ed25519'],
  );
  assert.deepEqual(scanned[0], {
    type: 'seed',
    index: '01',
    metadata: '',
    alias: '',
    secret: true,
    derivations: [],
  });
  assert.equal(scanned[1].ref.addressType, 'solana');
  assert.deepEqual(progress, [
    [0, 2, 'keys'],
    [1, 2, 'keys'],
    [2, 2, 'keys'],
  ]);

  for (const failure of [
    new CardItemNotFoundError({code: 'NOT_FOUND'}),
    new Error('Card disconnected'),
  ]) {
    applet.viewKey = async () => {
      throw failure;
    };
    await assert.rejects(
      scanCardItems(applet, () => {}),
      error => error === failure,
    );
    await assert.rejects(
      readCardKeyAddress(applet, {type: 'seed', index: INDEX}, 'evm'),
      error => error === failure,
    );
  }
});

for (const [type, index] of [
  ['seed', '02400000000000000001'],
  ['secp256k1', '03010000000000000001'],
  ['ed25519', '04010000000000000001'],
]) {
  test(`an explicit empty ${type} address record suppresses default address previews`, async () => {
    const recordIndex = getCardDerivationItemIndex(index);
    const reads = [];
    const progress = [];
    const items = await scanCardItems(
      {
        list: async () => ({
          items: [
            {type, index: bytes(index), secret: true},
            {index: bytes(recordIndex), metadata: bytes(index), secret: false},
          ],
        }),
        get: async request => {
          reads.push(request);
          return {data: encodeCardDerivationRecord({index, wallets: []})};
        },
        viewKey: () =>
          assert.fail('An empty address list must not create a preview'),
      },
      (...value) => progress.push(value),
    );

    assert.deepEqual(reads, [{index: bytes(recordIndex)}]);
    assert.deepEqual(items[0].derivations, []);
    assert.equal(items[0].ref, undefined);
    assert.deepEqual(items[1].derivationRecord, {index, wallets: []});
    assert.deepEqual(progress, [
      [0, 1, 'records'],
      [1, 1, 'records'],
    ]);
  });
}

for (const [type, index, addressType, publicKey] of [
  ['secp256k1', '03010000000000000001', 'bitcoin-segwit', PUBLIC_KEY],
  ['ed25519', '04010000000000000001', 'solana', '00'.repeat(32)],
]) {
  test(`scanning ${type} keeps the native record separate from its default preview`, async () => {
    const wallets = [
      {addressType, seed: undefined, curve: undefined, path: undefined},
    ];
    const recordIndex = getCardDerivationItemIndex(index);
    const requests = [];
    const items = await scanCardItems(
      {
        list: async () => ({
          items: [
            {index: bytes(recordIndex), metadata: bytes(index), secret: false},
            {type, index: bytes(index), secret: true},
          ],
        }),
        get: async () => ({data: encodeCardDerivationRecord({index, wallets})}),
        viewKey: async request => {
          requests.push(request);
          return {publicKey: bytes(publicKey)};
        },
      },
      () => {},
    );

    assert.deepEqual(requests, [{type, index: bytes(index)}]);
    assert.deepEqual(items[0].derivationRecord, {index, wallets});
    assert.deepEqual(items[1].derivations, [{...wallets[0], publicKey}]);
    assert.equal(
      items[1].ref.addressType,
      type === 'ed25519' ? 'solana' : 'evm',
    );
    assert.equal(items[1].ref.publicKey, publicKey);
    assert.equal(items[1].ref.path, undefined);
  });
}

test('all five supported card key types are classified independently of secrecy or address availability', () => {
  const ref = {addressType: 'evm', publicKey: PUBLIC_KEY, address: EVM_ADDRESS};
  for (const type of ['entropy', 'seed', 'secp256k1', 'secp256r1', 'ed25519']) {
    for (const secret of [false, true]) {
      assert.equal(isCardKeyItem({type, index: INDEX, secret}), true);
      assert.equal(isCardKeyItem({type, index: INDEX, secret, ref}), true);
    }
  }
  for (const type of [undefined, 'master', 'note', 'unknown', 123]) {
    assert.equal(isCardKeyItem({type, index: INDEX, secret: true, ref}), false);
  }
});

test('entropy and non-key resources need no viewKey calls or key progress', async () => {
  const items = ['entropy', 'note', undefined].map((type, position) => ({
    ...(type !== undefined && {type}),
    index: new Uint8Array([position + 1]),
    secret: position % 2 === 0,
  }));
  const scanned = await scanCardItems(
    {
      list: async () => ({items}),
      viewKey: () => assert.fail('Unexpected address request'),
    },
    () => assert.fail('Unexpected address progress'),
  );
  assert.equal(scanned.length, items.length);
  assert.ok(scanned.every(item => item.ref === undefined));
  assert.ok(scanned.every(item => item.publicKey === undefined));
});

test('equivalent derivation requests share one read while preserving their separate address records', async () => {
  const path = "m/44'/60'/0'/0/7";
  const wallets = ['evm', 'bitcoin-segwit', 'evm'].map(addressType => ({
    addressType,
    seed: 'Bitcoin seed',
    curve: 'secp256k1',
    path,
  }));
  const requests = [];
  const progress = [];
  const applet = {
    async viewKey(request) {
      requests.push(request);
      return {publicKey: bytes(PUBLIC_KEY)};
    },
  };

  const derived = await readCardWalletDerivations(
    applet,
    {type: 'seed', index: INDEX},
    wallets,
    undefined,
    (current, total) => progress.push([current, total, requests.length]),
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(progress, [
    [1, 3, 1],
    [2, 3, 1],
    [3, 3, 1],
  ]);
  assert.deepEqual(
    derived,
    wallets.map(wallet => ({...wallet, publicKey: PUBLIC_KEY})),
  );

  await readCardWalletDerivations(
    applet,
    {type: 'seed', index: '00000002'},
    wallets,
  );
  assert.equal(requests.length, 2, 'reads are never reused across roots');
});

test('Taproot output, path, and derivation curve stay separate despite equal-looking public keys', async () => {
  const path = "m/44'/60'/0'/0'/7'";
  const base = {
    addressType: 'evm',
    seed: 'Bitcoin seed',
    curve: 'secp256k1',
    path,
  };
  const wallets = [
    base,
    {...base, addressType: 'bitcoin-taproot'},
    {...base, path: "m/44'/60'/0'/0'/8'"},
    {
      ...base,
      addressType: 'solana',
      seed: 'ed25519 seed',
      curve: 'ed25519',
    },
  ];
  const requests = [];
  const derived = await readCardWalletDerivations(
    {
      async viewKey(request) {
        requests.push(request);
        return {
          publicKey: bytes(
            request.taproot || request.derivation.type === 'slip10'
              ? TAPROOT_KEY
              : PUBLIC_KEY,
          ),
        };
      },
    },
    {type: 'seed', index: INDEX},
    wallets,
  );

  assert.equal(requests.length, 4);
  assert.equal(requests[0].taproot, undefined);
  assert.equal(requests[1].taproot, true);
  assert.deepEqual(
    derived.map(({publicKey: _publicKey, ...wallet}) => wallet),
    wallets,
  );
});

test('local reuse preserves the target address type and requires equivalent seed, curve, path, and output', () => {
  const source = {
    addressType: 'evm',
    seed: 'Bitcoin seed',
    curve: 'secp256k1',
    path: "m/44'/60'/0'/0/7",
    publicKey: PUBLIC_KEY,
  };
  const {publicKey, ...parameters} = source;
  const target = {...parameters, addressType: 'bitcoin-segwit'};

  assert.deepEqual(getLocalCardWalletDerivation([source], target), {
    ...target,
    publicKey,
  });
  for (const different of [
    {...target, seed: 'ed25519 seed'},
    {...target, curve: 'ed25519'},
    {...target, path: "m/44'/60'/0'/0/8"},
    {...target, addressType: 'bitcoin-taproot'},
  ]) {
    assert.equal(getLocalCardWalletDerivation([source], different), undefined);
  }
});

test('derivation request reuse still observes cancellation before a cached result', async () => {
  const controller = new AbortController();
  const wallet = {
    addressType: 'evm',
    seed: 'Bitcoin seed',
    curve: 'secp256k1',
    path: "m/44'/60'/0'/0/7",
  };
  let reads = 0;
  const progress = [];

  await assert.rejects(
    readCardWalletDerivations(
      {
        async viewKey() {
          reads++;
          controller.abort();
          return {publicKey: bytes(PUBLIC_KEY)};
        },
      },
      {type: 'seed', index: INDEX},
      [wallet, {...wallet, addressType: 'bitcoin-segwit'}],
      controller.signal,
      (...value) => progress.push(value),
    ),
    {code: 'CANCELLED'},
  );
  assert.equal(reads, 1);
  assert.deepEqual(progress, [[1, 2]]);
});

test('reading no addresses reports no completed address', async () => {
  const derived = await readCardWalletDerivations(
    {viewKey: () => assert.fail('No public key should be requested')},
    {type: 'seed', index: INDEX},
    [],
    undefined,
    () => assert.fail('An empty address list has no progress'),
  );
  assert.deepEqual(derived, []);
});

test('known previews only replace equivalent reads and never add unrequested addresses', async () => {
  const known = {
    addressType: 'evm',
    seed: 'Bitcoin seed',
    curve: 'secp256k1',
    path: "m/44'/60'/0'/0/7",
    publicKey: PUBLIC_KEY,
  };
  const {publicKey: _publicKey, ...parameters} = known;
  const requested = [
    {...parameters, addressType: 'bitcoin-segwit'},
    {...parameters, addressType: 'bitcoin-taproot'},
  ];
  const calls = [];
  const derived = await readCardWalletDerivations(
    {
      async viewKey(request) {
        calls.push(request);
        return {publicKey: bytes(TAPROOT_KEY)};
      },
    },
    {type: 'seed', index: INDEX},
    requested,
    undefined,
    undefined,
    [
      known,
      {...known, publicKey: TAPROOT_KEY},
      {...known, path: "m/44'/60'/0'/0/8"},
    ],
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taproot, true);
  assert.deepEqual(derived, [
    {...requested[0], publicKey: PUBLIC_KEY},
    {...requested[1], publicKey: TAPROOT_KEY},
  ]);
});
