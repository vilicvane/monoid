import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  CARD_DERIVATIONS_TYPE,
  encodeCardDerivationRecord,
  getCardDerivationItemIndex,
} from '../.bld/app/@components/views/safe/card-derivations.js';
import {
  readCardAddressPreviews,
  scanCardItems,
} from '../.bld/app/@components/views/safe/scan-card.js';
import {parseDerivationPath} from '../.bld/app/@lib/bip39.js';
import {CBORAppletError} from '../.bld/app/@lib/cbor-applet.js';
import {ADDRESS_TYPES} from '../.bld/app/@lib/wallet-address.js';

const ROOT = '02000000000000000001';
const OTHER_SEED = '02400000000000000001';
const ORPHAN = '02000000000000000002';
const PUBLIC_KEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const TAPROOT_KEY =
  'a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c';
const SOLANA_KEY = '00'.repeat(32);
const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
const hex = value => Buffer.from(value).toString('hex');

function wallet(addressType, path) {
  const options = ADDRESS_TYPES[addressType];
  return {
    addressType,
    seed: options.seed,
    curve: options.curve,
    path,
  };
}

function resource(index, type) {
  return {index: bytes(index), type, secret: true};
}

function metadata(index, wallets) {
  return {
    item: {
      index: bytes(getCardDerivationItemIndex(index)),
      type: CARD_DERIVATIONS_TYPE,
      key: bytes(index),
      secret: false,
    },
    data: encodeCardDerivationRecord({index, wallets}),
  };
}

function createApplet(resources, records = []) {
  const calls = {get: [], viewKey: []};
  const applet = {
    async list(request) {
      assert.deepEqual(request, {});
      return {items: resources};
    },
    async get(request) {
      calls.get.push(request);
      const record = records.find(
        record => hex(record.item.index) === hex(request.index),
      );
      assert.ok(record, 'Only derivation resources should be read');
      return {data: record.data};
    },
    async viewKey(request) {
      calls.viewKey.push(request);
      return {
        publicKey: bytes(
          request.taproot
            ? TAPROOT_KEY
            : request.derivation?.curve === 'ed25519'
              ? SOLANA_KEY
              : PUBLIC_KEY,
        ),
      };
    },
  };
  return {applet, calls};
}

test('scan restores multiple paths of one address type without adding a default wallet', async () => {
  const wallets = [
    wallet('evm', "m/44'/60'/0'/0/7"),
    wallet('evm', "m/44'/60'/0'/0/9"),
  ];
  const record = metadata(ROOT, wallets);
  const {applet, calls} = createApplet(
    [resource(ROOT, 'seed'), record.item],
    [record],
  );
  const progress = [];

  const items = await scanCardItems(applet, (...value) => progress.push(value));
  const root = items[0];

  assert.equal(calls.get.length, 1);
  assert.deepEqual(
    calls.viewKey.map(request => hex(request.derivation.path)),
    wallets.map(source => hex(parseDerivationPath(source.path))),
  );
  assert.deepEqual(
    root.derivations,
    wallets.map(source => ({
      ...source,
      publicKey: PUBLIC_KEY,
    })),
  );
  assert.equal(root.ref.path, wallets[0].path);
  assert.equal(root.ref.address, '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  assert.deepEqual(items[1].derivationRecord, {index: ROOT, wallets});
  assert.deepEqual(progress, [
    [0, 1, 'records'],
    [1, 1, 'records'],
    [0, 2, 'keys'],
    [1, 2, 'keys'],
    [2, 2, 'keys'],
  ]);
});

test('scan requests the Taproot output key for a stored Taproot wallet', async () => {
  const record = metadata(ROOT, [wallet('bitcoin-taproot', "m/86'/0'/0'/0/4")]);
  const {applet, calls} = createApplet(
    [record.item, resource(ROOT, 'seed')],
    [record],
  );

  const items = await scanCardItems(applet, () => {});

  assert.equal(calls.viewKey.length, 1);
  assert.equal(calls.viewKey[0].taproot, true);
  assert.equal(items[1].derivations[0].publicKey, TAPROOT_KEY);
  assert.equal(items[1].ref.addressType, 'bitcoin-taproot');
  assert.match(items[1].ref.address, /^bc1p/);
});

test('scan associates records by the full source index, including the type prefix', async () => {
  const seedRecord = metadata(ROOT, [wallet('evm', "m/44'/60'/0'/0/2")]);
  const secondRecord = metadata(OTHER_SEED, [
    wallet('solana', "m/44'/501'/3'/0'"),
  ]);
  const {applet, calls} = createApplet(
    [
      resource(ROOT, 'seed'),
      resource(OTHER_SEED, 'seed'),
      secondRecord.item,
      seedRecord.item,
    ],
    [seedRecord, secondRecord],
  );

  const items = await scanCardItems(applet, () => {});

  assert.equal(items[0].derivations[0].addressType, 'evm');
  assert.equal(items[1].derivations[0].addressType, 'solana');
  assert.equal(items[1].derivations[0].seed, 'ed25519 seed');
  assert.equal(calls.viewKey[1].type, 'seed');
  assert.equal(calls.viewKey[1].derivation.type, 'slip10');
  assert.equal(calls.viewKey[1].derivation.curve, 'ed25519');
  assert.equal(hex(calls.viewKey[1].index), OTHER_SEED);
});

test('scan preserves orphan metadata and unrelated resources without applying orphan paths', async () => {
  const orphan = metadata(ORPHAN, [wallet('evm', "m/44'/60'/0'/0/8")]);
  const generic = {
    index: bytes('10200000000000000004'),
    type: 0x1020,
    alias: 'Notes',
    key: bytes('aabb'),
    secret: false,
  };
  const {applet, calls} = createApplet(
    [resource(ROOT, 'seed'), orphan.item, generic],
    [orphan],
  );

  const items = await scanCardItems(applet, () => {});

  assert.equal(calls.get.length, 1);
  assert.equal(calls.viewKey.length, 1);
  assert.equal(items[0].ref.path, ADDRESS_TYPES.evm.path(0));
  assert.deepEqual(items[0].derivations, []);
  assert.equal(items[1].derivationRecord.index, ORPHAN);
  assert.deepEqual(items[2], {
    index: hex(generic.index),
    type: generic.type,
    alias: 'Notes',
    key: 'aabb',
    secret: false,
  });
});

test('malformed record source identifiers still fail before scanning supported keys', async () => {
  for (const key of [undefined, new Uint8Array(), bytes('0240')]) {
    const record = {
      index: bytes('0f010000000000000003'),
      type: CARD_DERIVATIONS_TYPE,
      key,
      secret: false,
    };
    const {applet, calls} = createApplet([resource(ROOT, 'seed'), record]);

    await assert.rejects(
      scanCardItems(applet, () => {}),
      /Invalid derivation/,
    );
    assert.deepEqual(calls, {get: [], viewKey: []});
  }
});

test('an empty record preserves an explicit empty list without reading a default address', async () => {
  const record = metadata(ROOT, []);
  const {applet, calls} = createApplet(
    [resource(ROOT, 'seed'), record.item],
    [record],
  );

  const items = await scanCardItems(applet, () => {});

  assert.equal(calls.get.length, 1);
  assert.equal(calls.viewKey.length, 0);
  assert.deepEqual(items[0].derivations, []);
  assert.equal(items[0].ref, undefined);
  assert.deepEqual(items[1].derivationRecord, {index: ROOT, wallets: []});
});

test('invalid recognized metadata fails the scan before deriving keys', async () => {
  const record = metadata(ROOT, []);
  record.data = Uint8Array.of(0xff);
  const {applet, calls} = createApplet(
    [resource(ROOT, 'seed'), record.item],
    [record],
  );

  await assert.rejects(scanCardItems(applet, () => {}));
  assert.equal(calls.viewKey.length, 0);
});

test('a stored derivation unsupported by this card fails instead of silently dropping it', async () => {
  const record = metadata(ROOT, [wallet('evm', "m/44'/60'/0'/0/2")]);
  const {applet} = createApplet(
    [resource(ROOT, 'seed'), record.item],
    [record],
  );
  const unsupported = new CBORAppletError({code: 'UNSUPPORTED_DERIVATION'});
  applet.viewKey = async () => {
    throw unsupported;
  };

  await assert.rejects(
    scanCardItems(applet, () => {}),
    error => error === unsupported,
  );
});

test('an unsupported default display derivation still leaves the key available', async () => {
  const {applet} = createApplet([resource(ROOT, 'seed')]);
  applet.viewKey = async () => {
    throw new CBORAppletError({code: 'UNSUPPORTED_DERIVATION'});
  };

  const items = await scanCardItems(applet, () => {});

  assert.equal(items.length, 1);
  assert.equal(items[0].index, ROOT);
  assert.equal(items[0].ref, undefined);
  assert.deepEqual(items[0].derivations, []);
});

test('scan progress uses stable stages and counts every saved address, including reused public keys', async () => {
  const path = "m/44'/60'/0'/0/7";
  const record = metadata(ROOT, [
    wallet('evm', path),
    wallet('bitcoin-segwit', path),
    wallet('evm', "m/44'/60'/0'/0/8"),
  ]);
  const empty = metadata(OTHER_SEED, []);
  const {applet, calls} = createApplet(
    [
      resource(ROOT, 'seed'),
      record.item,
      resource(OTHER_SEED, 'seed'),
      empty.item,
      resource('03010000000000000001', 'secp256k1'),
      resource('03020000000000000001', 'secp256r1'),
    ],
    [record, empty],
  );
  const progress = [];
  const beforeReads = [];
  const originalViewKey = applet.viewKey;
  applet.viewKey = request => {
    beforeReads.push([...progress.at(-1)]);
    return originalViewKey(request);
  };

  await scanCardItems(applet, (...value) => progress.push(value));

  assert.deepEqual(progress, [
    [0, 2, 'records'],
    [1, 2, 'records'],
    [2, 2, 'records'],
    [0, 5, 'keys'],
    [1, 5, 'keys'],
    [2, 5, 'keys'],
    [3, 5, 'keys'],
    [4, 5, 'keys'],
    [5, 5, 'keys'],
  ]);
  assert.deepEqual(beforeReads, [
    [0, 5, 'keys'],
    [1, 5, 'keys'],
    [3, 5, 'keys'],
    [4, 5, 'keys'],
  ]);
  assert.equal(calls.viewKey.length, 4);
});

for (const stage of ['list', 'records', 'saved-key', 'preview', 'p256']) {
  test(`cancellation during ${stage} suppresses late progress and stops further card reads`, async () => {
    const controller = new AbortController();
    const record = metadata(ROOT, [
      wallet('evm', "m/44'/60'/0'/0/7"),
      wallet('evm', "m/44'/60'/0'/0/8"),
    ]);
    const resources =
      stage === 'records' || stage === 'saved-key'
        ? [resource(ROOT, 'seed'), record.item]
        : [
            resource(ROOT, stage === 'p256' ? 'secp256r1' : 'seed'),
            resource(OTHER_SEED, 'seed'),
          ];
    const {applet, calls} = createApplet(resources, [record]);
    const method =
      stage === 'list' ? 'list' : stage === 'records' ? 'get' : 'viewKey';
    const original = applet[method];
    const progress = [];
    let progressAtCancellation;
    applet[method] = async request => {
      const result = await original(request);
      controller.abort();
      progressAtCancellation = [...progress];
      return result;
    };

    await assert.rejects(
      scanCardItems(
        applet,
        (...value) => progress.push(value),
        controller.signal,
      ),
      {code: 'CANCELLED'},
    );

    assert.deepEqual(progress, progressAtCancellation);
    assert.equal(calls.viewKey.length, method === 'viewKey' ? 1 : 0);
    assert.equal(
      progress.some(
        ([current, total, kind]) => kind === 'keys' && current === total,
      ),
      false,
    );
  });
}

test('an already cancelled scan does not list the card', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    scanCardItems(
      {list: () => assert.fail('Cancelled scans must not start an APDU')},
      () => assert.fail('Cancelled scans must not publish progress'),
      controller.signal,
    ),
    {code: 'CANCELLED'},
  );
});

function confirmedItems(index, wallets) {
  return [
    {index, type: 'seed', secret: true},
    {
      index: getCardDerivationItemIndex(index),
      type: CARD_DERIVATIONS_TYPE,
      key: index,
      secret: false,
      derivationRecord: {index, wallets},
    },
  ];
}

test('confirmed-record hydration reads only missing previews, scoped to each source key', async () => {
  const known = wallet('evm', "m/44'/60'/0'/0/7");
  const added = wallet('evm', "m/44'/60'/0'/0/8");
  const extra = wallet('evm', "m/44'/60'/0'/0/9");
  const items = [
    ...confirmedItems(ROOT, [known, added]),
    ...confirmedItems(OTHER_SEED, [known]),
  ];
  const before = structuredClone(items);
  const {applet, calls} = createApplet([]);
  applet.list = () => assert.fail('Hydration must not list resources');
  applet.get = () => assert.fail('Confirmed records must not be reread');

  const hydrated = await readCardAddressPreviews(
    applet,
    items,
    () => {},
    undefined,
    [
      {
        index: ROOT,
        type: 'seed',
        secret: true,
        derivations: [known, extra].map(wallet => ({
          ...wallet,
          publicKey: PUBLIC_KEY,
        })),
      },
    ],
  );

  assert.deepEqual(items, before, 'Preview loading must not mutate ACK data');
  assert.deepEqual(
    calls.viewKey.map(request => [
      hex(request.index),
      hex(request.derivation.path),
    ]),
    [
      [ROOT, hex(parseDerivationPath(added.path))],
      [OTHER_SEED, hex(parseDerivationPath(known.path))],
    ],
  );
  assert.deepEqual(
    hydrated[0].derivations.map(({publicKey: _publicKey, ...wallet}) => wallet),
    [known, added],
    'Known previews must not add an address absent from the confirmed record',
  );
  assert.equal(hydrated[2].derivations.length, 1);
  assert.deepEqual(calls.get, []);
});

test('hydration keeps explicit empty records empty and reuses known default and native previews', async () => {
  const empty = confirmedItems(ROOT, []);
  const defaultWallet = {
    ...wallet('evm', ADDRESS_TYPES.evm.path(0)),
    publicKey: PUBLIC_KEY,
  };
  empty[0].ref = {...defaultWallet, address: 'old preview'};
  const native = '03010000000000000001';
  const p256 = '03020000000000000001';
  const items = [
    ...empty,
    {index: OTHER_SEED, type: 'seed', secret: true},
    {index: native, type: 'secp256k1', secret: true},
    {index: p256, type: 'secp256r1', secret: true},
  ];
  const knownItems = [
    {...empty[0], derivations: [defaultWallet]},
    {...items[2], ref: {...defaultWallet, address: 'cached'}},
    {
      ...items[3],
      derivations: [{addressType: 'bitcoin-segwit', publicKey: PUBLIC_KEY}],
    },
    {...items[4], publicKey: PUBLIC_KEY},
  ];
  const {applet, calls} = createApplet([]);
  applet.list = () => assert.fail('Hydration must not list resources');
  applet.get = () => assert.fail('Hydration must not read metadata');

  const hydrated = await readCardAddressPreviews(
    applet,
    items,
    () => {},
    undefined,
    knownItems,
  );

  assert.deepEqual(calls.viewKey, []);
  assert.deepEqual(hydrated[0].derivations, []);
  assert.equal(hydrated[0].ref, undefined);
  assert.equal(empty[0].ref.address, 'old preview');
  assert.equal(hydrated[2].ref.path, defaultWallet.path);
  assert.deepEqual(hydrated[2].derivations, []);
  assert.equal(hydrated[3].ref.addressType, 'evm');
  assert.equal(hydrated[4].publicKey, PUBLIC_KEY);
});

test('interrupted hydration does not publish partially resolved previews into the confirmed snapshot', async () => {
  const controller = new AbortController();
  const known = wallet('evm', "m/44'/60'/0'/0/7");
  const items = confirmedItems(ROOT, [
    known,
    wallet('evm', "m/44'/60'/0'/0/8"),
  ]);
  const before = structuredClone(items);
  const progress = [];
  const {applet, calls} = createApplet([]);
  const viewKey = applet.viewKey;
  applet.viewKey = async request => {
    const result = await viewKey(request);
    controller.abort();
    return result;
  };

  await assert.rejects(
    readCardAddressPreviews(
      applet,
      items,
      (...value) => progress.push(value),
      controller.signal,
      [{...items[0], derivations: [{...known, publicKey: PUBLIC_KEY}]}],
    ),
    {code: 'CANCELLED'},
  );

  assert.deepEqual(items, before);
  assert.deepEqual(progress, [
    [0, 2],
    [1, 2],
  ]);
  assert.equal(calls.viewKey.length, 1);
});
