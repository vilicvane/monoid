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

function localKey(index, wallets, defaultWallet) {
  return {index, type: 'seed', alias: undefined, wallets, defaultWallet};
}

function metadata(index, wallets) {
  return {
    item: {
      index: bytes(getCardDerivationItemIndex(index)),
      type: CARD_DERIVATIONS_TYPE,
      metadata: bytes(index),
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

test('scan keeps recorded paths as metadata and reads only the default preview for a key absent from Safe', async () => {
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
    [hex(parseDerivationPath(ADDRESS_TYPES.evm.path(0)))],
  );
  assert.deepEqual(root.derivations, []);
  assert.equal(root.ref.path, ADDRESS_TYPES.evm.path(0));
  assert.equal(root.ref.address, '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  assert.deepEqual(items[1].derivationRecord, {index: ROOT, wallets});
  assert.deepEqual(progress, [
    [0, 1, 'records'],
    [1, 1, 'records'],
    [0, 1, 'keys'],
    [1, 1, 'keys'],
  ]);
});

test('a stored Taproot address does not change the default display derivation', async () => {
  const record = metadata(ROOT, [wallet('bitcoin-taproot', "m/86'/0'/0'/0/4")]);
  const {applet, calls} = createApplet(
    [record.item, resource(ROOT, 'seed')],
    [record],
  );

  const items = await scanCardItems(applet, () => {});

  assert.equal(calls.viewKey.length, 1);
  assert.equal(calls.viewKey[0].taproot, undefined);
  assert.deepEqual(items[1].derivations, []);
  assert.equal(items[1].ref.addressType, 'evm');
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

  const items = await scanCardItems(applet, () => {}, undefined, [
    localKey(ROOT, [
      {...wallet('evm', "m/44'/60'/0'/0/2"), publicKey: PUBLIC_KEY},
    ]),
    localKey(OTHER_SEED, [
      {...wallet('solana', "m/44'/501'/3'/0'"), publicKey: SOLANA_KEY},
    ]),
  ]);

  assert.equal(items[0].derivations[0].addressType, 'evm');
  assert.equal(items[1].derivations[0].addressType, 'solana');
  assert.equal(items[1].derivations[0].seed, 'ed25519 seed');
  assert.deepEqual(calls.viewKey, []);
});

test('Safe supplies its selected address at a custom path without reading card public keys', async () => {
  const first = {...wallet('evm', "m/44'/60'/0'/0/7"), publicKey: PUBLIC_KEY};
  const selected = {
    ...wallet('solana', "m/44'/501'/5'/0'"),
    publicKey: SOLANA_KEY,
  };
  const recorded = [
    wallet('evm', "m/44'/60'/0'/0/1"),
    wallet('evm', "m/44'/60'/0'/0/2"),
  ];
  const record = metadata(ROOT, recorded);
  const {applet, calls} = createApplet(
    [resource(ROOT, 'seed'), record.item],
    [record],
  );
  const keys = [localKey(ROOT, [first, selected], selected)];
  const before = structuredClone(keys);
  const progress = [];

  const items = await scanCardItems(
    applet,
    (...value) => progress.push(value),
    undefined,
    keys,
  );

  assert.deepEqual(calls.viewKey, []);
  assert.equal(items[0].ref.addressType, 'solana');
  assert.equal(items[0].ref.path, selected.path);
  assert.equal(items[0].ref.publicKey, selected.publicKey);
  assert.deepEqual(items[0].derivations, []);
  assert.deepEqual(items[1].derivationRecord.wallets, recorded);
  assert.deepEqual(
    keys,
    before,
    'Scanning must not import or edit Safe addresses',
  );
  assert.deepEqual(progress, [
    [0, 1, 'records'],
    [1, 1, 'records'],
  ]);
});

test('an invalid local default falls back to the first existing Safe address', async () => {
  const first = {...wallet('evm', "m/44'/60'/0'/0/7"), publicKey: PUBLIC_KEY};
  const {applet, calls} = createApplet([resource(ROOT, 'seed')]);
  const items = await scanCardItems(applet, () => {}, undefined, [
    localKey(ROOT, [first], wallet('evm', "m/44'/60'/0'/0/8")),
  ]);

  assert.deepEqual(calls.viewKey, []);
  assert.equal(items[0].ref.path, first.path);
});

test('a Safe key without addresses still receives only the ordinary default preview', async () => {
  const record = metadata(ROOT, [wallet('evm', "m/44'/60'/0'/0/7")]);
  const {applet, calls} = createApplet(
    [resource(ROOT, 'seed'), record.item],
    [record],
  );
  const items = await scanCardItems(applet, () => {}, undefined, [
    localKey(ROOT, []),
  ]);

  assert.equal(calls.viewKey.length, 1);
  assert.equal(items[0].ref.path, ADDRESS_TYPES.evm.path(0));
  assert.deepEqual(items[0].derivations, []);
});

test('Safe address reuse requires both the source index and key type to match', async () => {
  const {applet, calls} = createApplet([resource(ROOT, 'seed')]);
  const items = await scanCardItems(applet, () => {}, undefined, [
    {
      ...localKey(ROOT, [{addressType: 'evm', publicKey: PUBLIC_KEY}]),
      type: 'secp256k1',
    },
    localKey(OTHER_SEED, [
      {...wallet('solana', "m/44'/501'/5'/0'"), publicKey: SOLANA_KEY},
    ]),
  ]);

  assert.equal(calls.viewKey.length, 1);
  assert.equal(items[0].ref.path, ADDRESS_TYPES.evm.path(0));
});

test('scan skips orphan metadata and preserves unrelated resources without applying orphan paths', async () => {
  const orphan = metadata(ORPHAN, [wallet('evm', "m/44'/60'/0'/0/8")]);
  const generic = {
    index: bytes('10200000000000000004'),
    type: 0x1020,
    alias: 'Notes',
    metadata: bytes('aabb'),
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
  assert.equal(items.length, 2);
  assert.deepEqual(items[1], {
    index: hex(generic.index),
    type: generic.type,
    alias: 'Notes',
    metadata: 'aabb',
    secret: false,
  });
});

test('malformed record source identifiers are skipped while supported keys remain available', async () => {
  for (const metadata of [undefined, new Uint8Array(), bytes('0240')]) {
    const record = {
      index: bytes('0f010000000000000003'),
      type: CARD_DERIVATIONS_TYPE,
      metadata,
      secret: false,
    };
    const {applet, calls} = createApplet([resource(ROOT, 'seed'), record]);

    const items = await scanCardItems(applet, () => {});
    assert.deepEqual(
      items.map(item => item.index),
      [ROOT],
    );
    assert.equal(calls.get.length, 0);
    assert.equal(calls.viewKey.length, 1);
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

test('invalid recognized metadata is skipped before deriving the remaining keys', async () => {
  const record = metadata(ROOT, []);
  record.data = Uint8Array.of(0xff);
  const {applet, calls} = createApplet(
    [resource(ROOT, 'seed'), record.item],
    [record],
  );

  const items = await scanCardItems(applet, () => {});
  assert.deepEqual(
    items.map(item => item.index),
    [ROOT],
  );
  assert.equal(calls.viewKey.length, 1);
});

test('unsupported records do not hide valid records and do not swallow read failures', async () => {
  const invalid = metadata(ROOT, []);
  invalid.data = Uint8Array.of(0xff);
  const valid = metadata(OTHER_SEED, []);
  const {applet} = createApplet(
    [
      resource(ROOT, 'seed'),
      invalid.item,
      valid.item,
      resource(OTHER_SEED, 'seed'),
    ],
    [invalid, valid],
  );
  const items = await scanCardItems(applet, () => {});
  assert.deepEqual(
    items.map(item => item.index),
    [ROOT, hex(valid.item.index), OTHER_SEED],
  );
  assert.deepEqual(items[1].derivationRecord, {index: OTHER_SEED, wallets: []});
  for (const failure of [
    new Error('Tag lost'),
    new CBORAppletError({code: 'UNAUTHENTICATED'}),
  ]) {
    applet.get = async () => {
      throw failure;
    };
    await assert.rejects(
      scanCardItems(applet, () => {}),
      error => error === failure,
    );
  }
});

test('an unavailable default preview keeps the recorded addresses intact for later import', async () => {
  const wallets = [wallet('evm', "m/44'/60'/0'/0/2")];
  const record = metadata(ROOT, wallets);
  const {applet} = createApplet(
    [resource(ROOT, 'seed'), record.item],
    [record],
  );
  const unsupported = new CBORAppletError({code: 'UNSUPPORTED_DERIVATION'});
  applet.viewKey = async () => {
    throw unsupported;
  };

  const items = await scanCardItems(applet, () => {});
  assert.equal(items[0].ref, undefined);
  assert.deepEqual(items[0].derivations, []);
  assert.deepEqual(items[1].derivationRecord, {index: ROOT, wallets});
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

test('scan progress counts display reads rather than every recorded address', async () => {
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
    [0, 3, 'keys'],
    [1, 3, 'keys'],
    [2, 3, 'keys'],
    [3, 3, 'keys'],
  ]);
  assert.deepEqual(beforeReads, [
    [0, 3, 'keys'],
    [1, 3, 'keys'],
    [2, 3, 'keys'],
  ]);
  assert.equal(calls.viewKey.length, 3);
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
      metadata: index,
      secret: false,
      derivationRecord: {index, wallets},
    },
  ];
}

test('equivalent cached derivations cannot cross source keys during display hydration', async () => {
  const defaultWallet = wallet('evm', ADDRESS_TYPES.evm.path(0));
  const items = [
    ...confirmedItems(ROOT, [defaultWallet]),
    ...confirmedItems(OTHER_SEED, [defaultWallet]),
  ];
  const {applet, calls} = createApplet([]);
  const rootKey = `03${PUBLIC_KEY.slice(2)}`;
  const hydrated = await readCardAddressPreviews(
    applet,
    items,
    () => {},
    undefined,
    [{...items[0], derivations: [{...defaultWallet, publicKey: rootKey}]}],
  );

  assert.deepEqual(
    calls.viewKey.map(request => hex(request.index)),
    [OTHER_SEED],
  );
  assert.equal(hydrated[0].ref.publicKey, rootKey);
  assert.equal(hydrated[0].derivations[0].publicKey, rootKey);
  assert.equal(hydrated[2].ref.publicKey, PUBLIC_KEY);
  assert.equal(hydrated[2].derivations[0].publicKey, PUBLIC_KEY);
});

test('sparse hydration reuses equivalent public keys but never adds records absent from the card', async () => {
  const known = wallet('evm', "m/44'/60'/0'/0/7");
  const equivalent = {...known, addressType: 'bitcoin-segwit'};
  const missing = wallet('evm', "m/44'/60'/0'/0/8");
  const extra = wallet('evm', "m/44'/60'/0'/0/9");
  const items = confirmedItems(ROOT, [known, equivalent, missing]);
  const before = structuredClone(items);
  const local = [
    localKey(
      ROOT,
      [known, extra].map(value => ({...value, publicKey: PUBLIC_KEY})),
      extra,
    ),
  ];
  const {applet, calls} = createApplet([]);
  const hydrated = await readCardAddressPreviews(
    applet,
    items,
    () => {},
    undefined,
    [],
    local,
  );

  assert.deepEqual(calls.viewKey, []);
  assert.equal(hydrated[0].ref.path, extra.path);
  assert.deepEqual(
    hydrated[0].derivations,
    [known, equivalent].map(value => ({...value, publicKey: PUBLIC_KEY})),
  );
  assert.deepEqual(hydrated[1].derivationRecord.wallets, [
    known,
    equivalent,
    missing,
  ]);
  assert.deepEqual(items, before);
});

test('an explicit empty card record stays empty while Safe can supply a display reference', async () => {
  const selected = {
    ...wallet('evm', "m/44'/60'/0'/0/7"),
    publicKey: PUBLIC_KEY,
  };
  const {applet, calls} = createApplet([]);
  const hydrated = await readCardAddressPreviews(
    applet,
    confirmedItems(ROOT, []),
    () => assert.fail('No card address needs to be read'),
    undefined,
    [],
    [localKey(ROOT, [selected])],
  );

  assert.deepEqual(calls.viewKey, []);
  assert.deepEqual(hydrated[0].derivations, []);
  assert.equal(hydrated[0].ref.path, selected.path);
  assert.deepEqual(hydrated[1].derivationRecord.wallets, []);
});

test('hydration requires parsed address metadata before starting any default reads', async () => {
  const items = confirmedItems(ROOT, []);
  delete items[1].derivationRecord;
  const {applet, calls} = createApplet([]);
  await assert.rejects(
    readCardAddressPreviews(applet, items, () => {}),
    /Address records were not read/,
  );
  assert.deepEqual(calls.viewKey, []);
});

test('local native previews keep optional derivation fields omitted', async () => {
  const index = '03010000000000000001';
  const {applet, calls} = createApplet([resource(index, 'secp256k1')]);
  const items = await scanCardItems(applet, () => {}, undefined, [
    {
      ...localKey(index, [{addressType: 'evm', publicKey: PUBLIC_KEY}]),
      type: 'secp256k1',
    },
  ]);
  assert.deepEqual(calls.viewKey, []);
  assert.deepEqual(items[0].ref, {
    addressType: 'evm',
    publicKey: PUBLIC_KEY,
    address: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
  });
});

test('confirmed-record hydration preserves sparse known previews without reading every missing address', async () => {
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
      [ROOT, hex(parseDerivationPath(ADDRESS_TYPES.evm.path(0)))],
      [OTHER_SEED, hex(parseDerivationPath(ADDRESS_TYPES.evm.path(0)))],
    ],
  );
  assert.deepEqual(
    hydrated[0].derivations.map(({publicKey: _publicKey, ...wallet}) => wallet),
    [known],
    'Known previews must not add an address absent from the confirmed record',
  );
  assert.deepEqual(hydrated[2].derivations, []);
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
  assert.deepEqual(progress, [[0, 1]]);
  assert.equal(calls.viewKey.length, 1);
});
