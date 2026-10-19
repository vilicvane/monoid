import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';

import {decode, encode} from 'cbor2';

import {
  CARD_DERIVATIONS_TYPE,
  decodeCardDerivationRecord,
  encodeCardDerivationRecord,
  getCardDerivationItemIndex,
  isCardDerivationItem,
  mergeCardDerivationWallets,
  readCardDerivationRecord,
  writeCardDerivations,
} from '../.bld/app/@components/views/safe/card-derivations.js';
import {ADDRESS_TYPES} from '../.bld/app/@lib/wallet-address.js';

const SEED = {index: '02400000000000000001', type: 'seed'};
const OTHER_SEED = {index: '02400000000000000002', type: 'seed'};
const SECP256K1 = {index: '03010000000000000001', type: 'secp256k1'};
const ED25519 = {index: '04010000000000000001', type: 'ed25519'};
const SECP_PUBLIC_KEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const signal = () => new AbortController().signal;

function wallet(addressType = 'evm', account = 0, root = SEED) {
  const options = ADDRESS_TYPES[addressType];
  const derived = root.type === 'seed';

  return {
    addressType,
    seed: root.type === 'seed' ? options.seed : undefined,
    curve: derived ? options.curve : undefined,
    path: derived ? options.path(account) : undefined,
  };
}

function recordItem(root = SEED, wallets = [wallet('evm', 0, root)]) {
  return {
    index: getCardDerivationItemIndex(root.index),
    key: root.index,
    secret: false,
    data: encodeCardDerivationRecord({index: root.index, wallets}),
  };
}

function createApplet(initial = []) {
  const items = new Map(initial.map(item => [item.index, {...item}]));
  const calls = [];
  const applet = {
    items,
    calls,
    async view(request) {
      calls.push(['view', request]);
      assert.ok(
        [SEED, OTHER_SEED, SECP256K1, ED25519].some(
          root => root.index === hex(request.index),
        ),
      );
      return {secret: true};
    },
    async list(request) {
      calls.push(['list', request]);
      assert.equal(request.type, CARD_DERIVATIONS_TYPE);

      return {
        items: [...items.values()]
          .filter(item => item.key?.startsWith(hex(request.keyPrefix)))
          .map(({data: _data, ...item}) => ({
            ...item,
            index: bytes(item.index),
            key: bytes(item.key),
          })),
      };
    },
    async get(request) {
      calls.push(['get', request]);
      return {data: items.get(hex(request.index)).data};
    },
    async viewKey(request) {
      calls.push(['viewKey', request]);
      return {
        publicKey:
          request.type === 'ed25519' ||
          request.derivation?.type === 'slip10' ||
          request.taproot
            ? new Uint8Array(32)
            : bytes(SECP_PUBLIC_KEY),
      };
    },
    async create(request) {
      calls.push(['create', request]);
      assert.equal(items.has(hex(request.index)), false);
      items.set(hex(request.index), {
        ...request,
        index: hex(request.index),
        key: hex(request.key),
      });
      return {index: request.index};
    },
    async set(request) {
      calls.push(['set', request]);
      assert.deepEqual(Object.keys(request).sort(), ['data', 'index']);
      const item = items.get(hex(request.index));
      item.data = request.data;
      return {};
    },
  };

  return applet;
}

test('metadata indexes hash the complete source index and are independent of parameters', () => {
  const expected = `0f01${createHash('sha256').update(bytes(SEED.index)).digest('hex').slice(0, 16)}`;
  assert.equal(CARD_DERIVATIONS_TYPE, 0x0f01);
  assert.equal(getCardDerivationItemIndex(SEED.index), expected);
  assert.equal(bytes(expected).length, 10);
  assert.notEqual(getCardDerivationItemIndex(OTHER_SEED.index), expected);
  assert.equal(isCardDerivationItem({index: expected}), true);
  assert.equal(isCardDerivationItem({index: '0f010000000000000000'}), true);
  assert.equal(isCardDerivationItem({index: '0fff0000000000000000'}), false);
  assert.equal(isCardDerivationItem({index: '10010000000000000000'}), false);
  assert.equal(isCardDerivationItem({index: SEED.index}), false);
  assert.notEqual(getCardDerivationItemIndex(SECP256K1.index), expected);
  assert.notEqual(getCardDerivationItemIndex(ED25519.index), expected);
  assert.throws(() => getCardDerivationItemIndex('03020000000000000001'));
  assert.throws(() => getCardDerivationItemIndex('0240'));
});

test('unsupported master roots cannot be encoded, decoded or synchronized', async () => {
  const root = {index: '03200000000000000001', type: 'master'};
  const applet = createApplet();

  assert.throws(
    () => getCardDerivationItemIndex(root.index),
    /Invalid derivation source/,
  );
  assert.throws(
    () => encodeCardDerivationRecord({index: root.index, wallets: []}),
    /Invalid derivation source/,
  );
  assert.throws(
    () => decodeCardDerivationRecord(encode([1, bytes(root.index), []])),
    /Invalid derivation source/,
  );
  await assert.rejects(
    writeCardDerivations(applet, root, [], signal()),
    /Invalid derivation source/,
  );
  assert.deepEqual(applet.calls, []);
});

for (const [root, addressTypes] of [
  [SECP256K1, ['evm', 'bitcoin-segwit', 'bitcoin-taproot']],
  [ED25519, ['solana']],
]) {
  test(`${root.type} records encode one unpathed address per native group`, () => {
    const wallets = addressTypes.map(type => wallet(type, 0, root));
    const data = encodeCardDerivationRecord({index: root.index, wallets});

    assert.deepEqual(decode(data), [
      1,
      bytes(root.index),
      addressTypes.map(type => [root.type, type, []]),
    ]);
    assert.deepEqual(decodeCardDerivationRecord(data), {
      index: root.index,
      wallets,
    });
    assert.deepEqual(
      decodeCardDerivationRecord(
        encode([
          1,
          bytes(root.index),
          addressTypes.flatMap(type => [
            [root.type, type, []],
            [root.type, type, []],
          ]),
        ]),
      ).wallets,
      wallets,
    );
  });
}

test('zero groups retain an explicit empty address list for derived and native roots', () => {
  for (const root of [SEED, OTHER_SEED, SECP256K1, ED25519]) {
    const record = {index: root.index, wallets: []};
    const data = encodeCardDerivationRecord(record);
    assert.deepEqual(decode(data), [1, bytes(root.index), []]);
    assert.deepEqual(decodeCardDerivationRecord(data), record);
  }
});

test('native groups reject derivation fields, foreign address algorithms and unsupported roots', () => {
  const raw = wallet('evm', 0, SECP256K1);
  for (const [root, invalid] of [
    [SECP256K1, {...raw, path: 'm/0'}],
    [SECP256K1, {...raw, seed: 'Bitcoin seed'}],
    [SECP256K1, {...raw, curve: 'secp256k1'}],
    [SECP256K1, {...raw, addressType: 'solana'}],
    [ED25519, raw],
  ]) {
    assert.throws(() =>
      encodeCardDerivationRecord({index: root.index, wallets: [invalid]}),
    );
  }

  for (const [index, group] of [
    [SECP256K1.index, ['secp256k1', 'evm', [bytes('')]]],
    [SECP256K1.index, ['secp256k1', 'evm', [bytes('00000000')]]],
    [SECP256K1.index, ['bip32', 'evm', []]],
    [SECP256K1.index, ['ed25519', 'solana', []]],
    [SECP256K1.index, ['secp256k1', 'solana', []]],
    [ED25519.index, ['ed25519', 'evm', []]],
    [SEED.index, ['secp256k1', 'evm', []]],
    [OTHER_SEED.index, ['ed25519', 'solana', []]],
    ['03020000000000000001', ['secp256k1', 'evm', []]],
    ['01000000000000000001', ['ed25519', 'solana', []]],
  ]) {
    assert.throws(() =>
      decodeCardDerivationRecord(encode([1, bytes(index), [group]])),
    );
  }
});

test('seed records round-trip every supported wallet using card derivation parameters', () => {
  const wallets = Object.keys(ADDRESS_TYPES).map(type => wallet(type, 3));
  const record = {index: SEED.index, wallets};
  const data = encodeCardDerivationRecord(record);
  const payload = decode(data);

  assert.deepEqual(decodeCardDerivationRecord(data), record);
  assert.equal(payload.length, 3);
  assert.equal(payload[0], 1);
  assert.deepEqual(payload[1], bytes(SEED.index));
  assert.deepEqual(payload[2], [
    ['bip32', 'evm', [bytes('8000002c8000003c800000000000000000000003')]],
    ['slip10-ed25519', 'solana', [bytes('8000002c800001f58000000380000000')]],
    [
      'bip32',
      'bitcoin-segwit',
      [bytes('8000005480000000800000000000000000000003')],
    ],
    [
      'bip32',
      'bitcoin-taproot',
      [bytes('8000005680000000800000000000000000000003')],
    ],
  ]);
});

test('grouped paths omit repeated parameters and phone-local defaults', () => {
  const first = wallet('evm', 0);
  const second = wallet('evm', 1);
  const solana = wallet('solana', 2);
  const data = encodeCardDerivationRecord({
    index: SEED.index,
    wallets: [first, solana, second, first],
    defaultWallet: second,
  });
  const payload = decode(data);

  assert.deepEqual(payload, [
    1,
    bytes(SEED.index),
    [
      [
        'bip32',
        'evm',
        [
          bytes('8000002c8000003c800000000000000000000000'),
          bytes('8000002c8000003c800000000000000000000001'),
        ],
      ],
      ['slip10-ed25519', 'solana', [bytes('8000002c800001f58000000280000000')]],
    ],
  ]);
  assert.deepEqual(decodeCardDerivationRecord(data).wallets, [
    first,
    second,
    solana,
  ]);
});

test('equal paths in different address types remain independent logical records', () => {
  const evm = wallet();
  const segwit = {...wallet('bitcoin-segwit'), path: evm.path};
  const taproot = {...wallet('bitcoin-taproot'), path: evm.path};
  const wallets = [evm, segwit, taproot];
  const data = encodeCardDerivationRecord({index: SEED.index, wallets});

  assert.deepEqual(
    decode(data)[2].map(([type, addressType, paths]) => [
      type,
      addressType,
      paths.length,
    ]),
    [
      ['bip32', 'evm', 1],
      ['bip32', 'bitcoin-segwit', 1],
      ['bip32', 'bitcoin-taproot', 1],
    ],
  );
  assert.deepEqual(decodeCardDerivationRecord(data), {
    index: SEED.index,
    wallets,
  });
});

test('duplicate groups and paths normalize without merging distinct address types', () => {
  const path = bytes('8000002c8000003c800000000000000000000000');
  const record = decodeCardDerivationRecord(
    encode([
      1,
      bytes(SEED.index),
      [
        ['bip32', 'evm', [path, path]],
        ['bip32', 'evm', [path]],
        ['bip32', 'bitcoin-segwit', [path]],
      ],
    ]),
  );

  assert.deepEqual(record.wallets, [
    wallet(),
    {...wallet('bitcoin-segwit'), path: wallet().path},
  ]);
  assert.equal(decode(encodeCardDerivationRecord(record))[2].length, 2);
});

test('merging preserves both sides, deduplicates by wallet parameters, and drops caches', () => {
  const evm = wallet();
  const second = wallet('evm', 1);
  const solana = wallet('solana');
  const merged = mergeCardDerivationWallets(
    [{...evm, publicKey: 'untrusted', address: 'not retained'}],
    [evm, second, solana],
  );

  assert.deepEqual(merged, [evm, second, solana]);
  assert.notEqual(merged[0], evm);
});

test('invalid paths and parameter combinations cannot be encoded', () => {
  for (const invalid of [
    {...wallet(), path: "m/44'/2147483648/0"},
    {...wallet(), path: 'm/00'},
    {...wallet(), path: undefined},
    {...wallet(), curve: 'ed25519'},
    {...wallet(), seed: 'custom seed'},
    {...wallet('solana'), path: "m/44'/501'/0/0"},
    {...wallet('solana'), path: "m/44'/501'/999999999999999999999'"},
  ]) {
    assert.throws(() =>
      encodeCardDerivationRecord({index: SEED.index, wallets: [invalid]}),
    );
  }
});

test('unknown versions, tuple fields, algorithms and malformed binary paths are rejected', () => {
  const [version, index, groups] = decode(recordItem().data);
  const [type, addressType, paths] = groups[0];

  for (const invalid of [
    [2, index, groups],
    [version, index, groups, 0],
    [version, index],
    [version, bytes('03010000000000000001'), groups],
    [version, bytes('0240'), groups],
    [version, hex(index), groups],
    [version, index, [[type, addressType, paths, bytes('01')]]],
    [version, index, [[type, addressType]]],
    [version, index, [[type, 'unknown', paths]]],
    [version, index, [['future', addressType, paths]]],
    [version, index, [['slip10', 'solana', paths]]],
    [version, index, [[type, addressType, [bytes('0000')]]]],
    [version, index, [[type, addressType, [bytes('')]]]],
    [version, index, [[type, addressType, ["m/44'/60'/0'/0/0"]]]],
    [version, index, [[type, 'solana', paths]]],
    [version, index, [['slip10-ed25519', addressType, paths]]],
    [version, index, [['slip10-ed25519', 'solana', [bytes('00000000')]]]],
    // The former object payload was never shipped and is not supported.
    {version, index, keys: [{addressType, derivation: {type, path: paths[0]}}]},
  ]) {
    assert.throws(() => decodeCardDerivationRecord(encode(invalid)));
  }
});

test('read validates the payload, immutable lookup key and stable index together', async () => {
  const item = recordItem();
  const applet = createApplet([item]);

  assert.deepEqual(await readCardDerivationRecord(applet, item), {
    index: SEED.index,
    wallets: [wallet()],
  });

  for (const invalid of [
    {...item, secret: true},
    {...item, key: undefined},
    {...item, key: OTHER_SEED.index},
    {...item, index: '0f010000000000000000'},
  ]) {
    applet.calls.length = 0;
    await assert.rejects(readCardDerivationRecord(applet, invalid));
    assert.equal(applet.calls.length, 0);
  }

  applet.items.get(item.index).data = recordItem(OTHER_SEED).data;
  await assert.rejects(
    readCardDerivationRecord(applet, item),
    /does not match/,
  );
});

test('write creates an explicitly indexed non-secret item with the source lookup key', async () => {
  const applet = createApplet();
  const result = await writeCardDerivations(applet, SEED, [wallet()], signal());
  const created = applet.calls.find(([command]) => command === 'create')[1];

  assert.deepEqual(
    applet.calls.map(([command]) => command),
    ['view', 'list', 'viewKey', 'create'],
  );
  assert.equal('type' in created, false);
  assert.equal(created.secret, false);
  assert.deepEqual(created.key, bytes(SEED.index));
  assert.deepEqual(
    decodeCardDerivationRecord(created.data),
    result.derivationRecord,
  );
  assert.equal(result.index, getCardDerivationItemIndex(SEED.index));
  assert.deepEqual(result.derivations, [
    {...wallet(), publicKey: SECP_PUBLIC_KEY},
  ]);
});

test('write re-reads and merges on-card records, preserving unrelated metadata', async () => {
  const original = {...recordItem(), alias: 'Metadata'};
  const applet = createApplet([original]);
  const result = await writeCardDerivations(
    applet,
    SEED,
    [wallet('solana')],
    signal(),
  );

  assert.deepEqual(
    applet.calls.map(([command]) => command),
    ['view', 'list', 'get', 'viewKey', 'viewKey', 'set'],
  );
  assert.deepEqual(result.derivationRecord.wallets, [
    wallet(),
    wallet('solana'),
  ]);
  assert.equal(result.alias, 'Metadata');
  assert.equal(applet.items.get(original.index).alias, 'Metadata');

  applet.calls.length = 0;
  await writeCardDerivations(
    applet,
    SEED,
    [wallet('solana'), wallet()],
    signal(),
  );
  assert.deepEqual(
    applet.calls.map(([command]) => command),
    ['view', 'list', 'get', 'viewKey', 'viewKey'],
  );
});

test('write progress follows NFC work and counts the final merged address list', async () => {
  const applet = createApplet([recordItem()]);
  const events = [];
  await writeCardDerivations(
    applet,
    SEED,
    [wallet('solana')],
    signal(),
    undefined,
    event => {
      events.push({...event, after: applet.calls.at(-1)?.[0]});
    },
  );

  assert.deepEqual(events, [
    {stage: 'checking', current: 0, total: 1, after: undefined},
    {stage: 'reading', current: 0, total: 2, after: 'get'},
    {stage: 'reading', current: 1, total: 2, after: 'viewKey'},
    {stage: 'reading', current: 2, total: 2, after: 'viewKey'},
    {stage: 'writing', current: 0, total: 1, after: 'viewKey'},
    {stage: 'writing', current: 1, total: 1, after: 'set'},
  ]);
});

test('unchanged records report every address including reused reads without a writing stage', async () => {
  const wallets = [
    wallet('evm', 0, SECP256K1),
    wallet('bitcoin-segwit', 0, SECP256K1),
  ];
  const applet = createApplet([recordItem(SECP256K1, wallets)]);
  const events = [];
  await writeCardDerivations(
    applet,
    SECP256K1,
    wallets,
    signal(),
    undefined,
    event => events.push(event),
  );

  assert.deepEqual(events, [
    {stage: 'checking', current: 0, total: 1},
    {stage: 'reading', current: 0, total: 2},
    {stage: 'reading', current: 1, total: 2},
    {stage: 'reading', current: 2, total: 2},
  ]);
  assert.equal(
    applet.calls.filter(([command]) => command === 'viewKey').length,
    1,
  );
  assert.equal(
    applet.calls.some(([command]) => command === 'set' || command === 'create'),
    false,
  );
});

test('replace progress counts only the retained list and preserves the options parameter', async () => {
  const previous = [wallet(), wallet('solana')];
  const retained = [wallet('solana')];
  const applet = createApplet([recordItem(SEED, previous)]);
  const events = [];
  const result = await writeCardDerivations(
    applet,
    SEED,
    retained,
    signal(),
    {mode: 'replace', expected: previous},
    event => events.push(event),
  );

  assert.deepEqual(result.derivationRecord.wallets, retained);
  assert.deepEqual(events, [
    {stage: 'checking', current: 0, total: 1},
    {stage: 'reading', current: 0, total: 1},
    {stage: 'reading', current: 1, total: 1},
    {stage: 'writing', current: 0, total: 1},
    {stage: 'writing', current: 1, total: 1},
  ]);
});

test('clearing and retrying an empty address list never reports reading zero of zero', async () => {
  const previous = [wallet()];
  const applet = createApplet([recordItem(SEED, previous)]);
  const events = [];
  const options = {mode: 'replace', expected: previous};
  await writeCardDerivations(applet, SEED, [], signal(), options, event =>
    events.push(event),
  );
  assert.deepEqual(events, [
    {stage: 'checking', current: 0, total: 1},
    {stage: 'writing', current: 0, total: 1},
    {stage: 'writing', current: 1, total: 1},
  ]);

  events.length = 0;
  await writeCardDerivations(applet, SEED, [], signal(), options, event =>
    events.push(event),
  );
  assert.deepEqual(events, [{stage: 'checking', current: 0, total: 1}]);
});

test('a lost write response does not report an acknowledged writing completion', async () => {
  const applet = createApplet();
  const create = applet.create;
  applet.create = async request => {
    await create(request);
    throw new Error('Response lost');
  };
  const events = [];
  await assert.rejects(
    writeCardDerivations(applet, SEED, [wallet()], signal(), undefined, event =>
      events.push(event),
    ),
    /Response lost/,
  );
  assert.deepEqual(events.at(-1), {stage: 'writing', current: 0, total: 1});
  assert.equal(applet.items.size, 1);
});

for (const stage of ['checking', 'reading', 'writing']) {
  test(`cancellation when the ${stage} stage begins prevents its next NFC command`, async () => {
    const applet = createApplet();
    const controller = new AbortController();
    const events = [];
    await assert.rejects(
      writeCardDerivations(
        applet,
        SEED,
        [wallet()],
        controller.signal,
        undefined,
        event => {
          events.push(event);
          if (event.stage === stage && event.current === 0) controller.abort();
        },
      ),
      {code: 'CANCELLED'},
    );
    const commands = applet.calls.map(([command]) => command);
    assert.deepEqual(
      commands,
      stage === 'checking'
        ? []
        : stage === 'reading'
          ? ['view', 'list']
          : ['view', 'list', 'viewKey'],
    );
    assert.equal(events.at(-1).stage, stage);
    assert.equal(events.at(-1).current, 0);
  });
}

test('native address records read equivalent ordinary keys once and keep Taproot separate', async () => {
  const applet = createApplet();
  const wallets = ['evm', 'bitcoin-segwit', 'bitcoin-taproot'].map(type =>
    wallet(type, 0, SECP256K1),
  );
  const result = await writeCardDerivations(
    applet,
    SECP256K1,
    wallets,
    signal(),
  );

  assert.deepEqual(result.derivationRecord.wallets, wallets);
  assert.deepEqual(
    applet.calls
      .filter(([command]) => command === 'viewKey')
      .map(([, request]) => request),
    [
      {type: 'secp256k1', index: bytes(SECP256K1.index)},
      {type: 'secp256k1', index: bytes(SECP256K1.index), taproot: true},
    ],
  );
  assert.deepEqual(
    result.derivations.map(({publicKey, ...parameters}) => parameters),
    wallets,
  );
  assert.equal(result.derivations[0].publicKey, SECP_PUBLIC_KEY);
  assert.equal(result.derivations[1].publicKey, SECP_PUBLIC_KEY);
  assert.equal(result.derivations[2].publicKey, '00'.repeat(32));
});

test('replace writes a different same-sized set instead of merging or treating it as unchanged', async () => {
  const original = {
    ...recordItem(SEED, [wallet(), wallet('solana')]),
    alias: 'Addresses',
  };
  const applet = createApplet([original]);
  const requested = [wallet('evm', 1), wallet('bitcoin-segwit')];
  const result = await writeCardDerivations(applet, SEED, requested, signal(), {
    mode: 'replace',
    expected: [wallet('solana'), wallet(), wallet()],
  });

  assert.deepEqual(result.derivationRecord.wallets, requested);
  assert.deepEqual(
    decodeCardDerivationRecord(applet.items.get(original.index).data).wallets,
    requested,
  );
  assert.equal(result.alias, 'Addresses');
  assert.equal(applet.calls.filter(([command]) => command === 'set').length, 1);
});

test('replace rejects unexpected card changes even when the current set has the expected size', async () => {
  const original = recordItem(SEED, [wallet('evm', 2)]);
  const applet = createApplet([original]);

  await assert.rejects(
    writeCardDerivations(applet, SEED, [wallet('evm', 1)], signal(), {
      mode: 'replace',
      expected: [wallet()],
    }),
    /Card addresses changed, rescan card/,
  );
  assert.deepEqual(
    applet.calls.map(([command]) => command),
    ['view', 'list', 'get'],
  );
  assert.deepEqual(applet.items.get(original.index).data, original.data);
});

test('replace retries a committed target after a lost response without restoring removed addresses', async () => {
  const original = recordItem(SEED, [wallet(), wallet('evm', 1)]);
  const applet = createApplet([original]);
  const set = applet.set;
  const failure = new Error('Lost response');
  applet.set = async request => {
    await set(request);
    throw failure;
  };
  const options = {mode: 'replace', expected: [wallet(), wallet('evm', 1)]};

  await assert.rejects(
    writeCardDerivations(applet, SEED, [wallet('evm', 1)], signal(), options),
    error => error === failure,
  );
  const result = await writeCardDerivations(
    applet,
    SEED,
    [wallet('evm', 1)],
    signal(),
    options,
  );

  assert.deepEqual(result.derivationRecord.wallets, [wallet('evm', 1)]);
  assert.equal(applet.calls.filter(([command]) => command === 'set').length, 1);
});

test('replace distinguishes an absent record from an explicit empty record', async () => {
  for (const [initial, expected] of [
    [[], []],
    [[recordItem(SEED, [])], undefined],
  ]) {
    const applet = createApplet(initial);
    await assert.rejects(
      writeCardDerivations(applet, SEED, [wallet()], signal(), {
        mode: 'replace',
        expected,
      }),
      /Card addresses changed, rescan card/,
    );
    assert.equal(
      applet.calls.some(
        ([command]) => command === 'set' || command === 'create',
      ),
      false,
    );
  }

  const applet = createApplet();
  const result = await writeCardDerivations(applet, SEED, [], signal(), {
    mode: 'replace',
    expected: undefined,
  });
  assert.deepEqual(result.derivationRecord.wallets, []);
  assert.deepEqual(result.derivations, []);
  assert.deepEqual(
    applet.calls.map(([command]) => command),
    ['view', 'list', 'create'],
  );
  assert.deepEqual(decode(applet.items.get(result.index).data), [
    1,
    bytes(SEED.index),
    [],
  ]);
});

test('removing the last native address preserves an empty companion and retries without rewriting it', async () => {
  const address = wallet('solana', 0, ED25519);
  const original = recordItem(ED25519, [address]);
  const applet = createApplet([original]);
  const options = {mode: 'replace', expected: [address]};
  const result = await writeCardDerivations(
    applet,
    ED25519,
    [],
    signal(),
    options,
  );

  assert.deepEqual(result.derivations, []);
  assert.deepEqual(result.derivationRecord, {
    index: ED25519.index,
    wallets: [],
  });
  assert.deepEqual(
    applet.calls.map(([command]) => command),
    ['view', 'list', 'get', 'set'],
  );
  assert.deepEqual(decode(applet.items.get(result.index).data), [
    1,
    bytes(ED25519.index),
    [],
  ]);
  await writeCardDerivations(applet, ED25519, [], signal(), options);
  assert.equal(applet.calls.filter(([command]) => command === 'set').length, 1);
});

test('retry after a committed create with a lost response does not create twice', async () => {
  const applet = createApplet();
  const create = applet.create;
  const failure = new Error('Lost response');

  applet.create = async request => {
    await create(request);
    throw failure;
  };

  await assert.rejects(
    writeCardDerivations(applet, SEED, [wallet()], signal()),
    error => error === failure,
  );
  const recovered = await writeCardDerivations(
    applet,
    SEED,
    [wallet()],
    signal(),
  );

  assert.deepEqual(recovered.derivationRecord.wallets, [wallet()]);
  assert.equal(
    applet.calls.filter(([command]) => command === 'create').length,
    1,
  );
  assert.equal(applet.calls.filter(([command]) => command === 'set').length, 0);
});

test('malformed, foreign-prefix and duplicate records cannot be overwritten', async () => {
  const original = recordItem();

  for (const initial of [
    [{...original, data: encode([2, ...decode(original.data).slice(1)])}],
    [{...original, secret: true}],
    [{...original, key: `${SEED.index}00`}],
    [original, {...original, index: '0f010000000000000000'}],
  ]) {
    const applet = createApplet(initial);
    await assert.rejects(
      writeCardDerivations(applet, SEED, [wallet('solana')], signal()),
    );
    assert.equal(
      applet.calls.some(
        ([command]) => command === 'set' || command === 'create',
      ),
      false,
    );
  }
});

test('oversized merged records fail before replacing existing data', async () => {
  const original = recordItem();
  const applet = createApplet([original]);
  const wallets = Array.from({length: 400}, (_, i) => wallet('evm', i));

  await assert.rejects(
    writeCardDerivations(applet, SEED, wallets, signal()),
    /Too many derivation/,
  );
  assert.deepEqual(applet.items.get(original.index).data, original.data);
  assert.equal(
    applet.calls.some(([command]) => command === 'set'),
    false,
  );
});

test('size guard includes encrypted Copy overhead before creating a record', async () => {
  const applet = createApplet();
  const wallets = [];
  let createSize;
  let importSize;

  do {
    wallets.push(wallet('evm', wallets.length));
    const data = encodeCardDerivationRecord({index: SEED.index, wallets});
    const request = {
      index: bytes(getCardDerivationItemIndex(SEED.index)),
      key: bytes(SEED.index),
      data,
      secret: false,
    };
    createSize = encode(request).length;
    importSize = encode({
      index: request.index,
      senderPublicKey: new Uint8Array(65),
      key: request.key,
      data: new Uint8Array(data.length + 144),
    }).length;
  } while (importSize <= 8192);

  assert.ok(createSize <= 8192);
  await assert.rejects(
    writeCardDerivations(applet, SEED, wallets, signal()),
    /Too many derivation/,
  );
  assert.equal(applet.items.size, 0);
  assert.equal(
    applet.calls.some(
      ([command]) => command === 'viewKey' || command === 'create',
    ),
    false,
  );
});

test('public-key read failure or cancellation happens before any write', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const applet = createApplet([recordItem()]);
    const viewKey = applet.viewKey;
    applet.viewKey = async request => {
      if (!cancel) {
        throw new Error('Cannot derive this key');
      }

      const result = await viewKey(request);
      controller.abort();
      return result;
    };

    await assert.rejects(
      writeCardDerivations(applet, SEED, [wallet('solana')], controller.signal),
    );
    assert.equal(
      applet.calls.some(
        ([command]) => command === 'set' || command === 'create',
      ),
      false,
    );
    assert.deepEqual(
      decodeCardDerivationRecord(
        applet.items.get(getCardDerivationItemIndex(SEED.index)).data,
      ).wallets,
      [wallet()],
    );
  }
});

test('cancellation stops before any command or between reads without writing', async () => {
  const controller = new AbortController();
  const applet = createApplet([recordItem()]);
  controller.abort();

  await assert.rejects(
    writeCardDerivations(applet, SEED, [wallet()], controller.signal),
    {code: 'CANCELLED'},
  );
  assert.deepEqual(applet.calls, []);

  const next = new AbortController();
  const list = applet.list;
  applet.list = async request => {
    const result = await list(request);
    next.abort();
    return result;
  };

  await assert.rejects(
    writeCardDerivations(applet, SEED, [wallet('solana')], next.signal),
    {code: 'CANCELLED'},
  );
  assert.deepEqual(
    applet.calls.map(([command]) => command),
    ['view', 'list'],
  );
});

test('an acknowledged write is returned when cancellation arrives during the command', async () => {
  const controller = new AbortController();
  const applet = createApplet();
  const create = applet.create;
  applet.create = async request => {
    const result = await create(request);
    controller.abort();
    return result;
  };

  const events = [];
  const result = await writeCardDerivations(
    applet,
    SEED,
    [wallet()],
    controller.signal,
    undefined,
    event => events.push({...event, aborted: controller.signal.aborted}),
  );
  assert.deepEqual(result.derivationRecord.wallets, [wallet()]);
  assert.equal(applet.items.size, 1);
  assert.deepEqual(events.at(-1), {
    stage: 'writing',
    current: 1,
    total: 1,
    aborted: true,
  });
});
