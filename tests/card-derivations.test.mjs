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
const MASTER = {index: '03200000000000000001', type: 'master'};
const SECP_PUBLIC_KEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const signal = () => new AbortController().signal;

function wallet(addressType = 'evm', account = 0, root = SEED) {
  const options = ADDRESS_TYPES[addressType];

  return {
    addressType,
    seed: root.type === 'seed' ? options.seed : undefined,
    curve: options.curve,
    path: options.path(account),
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
      assert.ok([SEED.index, MASTER.index].includes(hex(request.index)));
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
          request.derivation.type === 'slip10' || request.taproot
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
  assert.notEqual(getCardDerivationItemIndex(MASTER.index), expected);
  assert.equal(isCardDerivationItem({index: expected}), true);
  assert.equal(isCardDerivationItem({index: '0f010000000000000000'}), true);
  assert.equal(isCardDerivationItem({index: '0fff0000000000000000'}), false);
  assert.equal(isCardDerivationItem({index: '10010000000000000000'}), false);
  assert.equal(isCardDerivationItem({index: SEED.index}), false);
  assert.throws(() => getCardDerivationItemIndex('04010000000000000001'));
  assert.throws(() => getCardDerivationItemIndex('0240'));
});

for (const root of [SEED, MASTER]) {
  test(`${root.type} records round-trip every supported wallet using card derivation parameters`, () => {
    const wallets = Object.keys(ADDRESS_TYPES).map(type =>
      wallet(type, 3, root),
    );
    const record = {index: root.index, wallets};
    const data = encodeCardDerivationRecord(record);
    const payload = decode(data);

    assert.deepEqual(decodeCardDerivationRecord(data), record);
    assert.equal(payload.length, 3);
    assert.equal(payload[0], 1);
    assert.deepEqual(payload[1], bytes(root.index));
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
}

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
    [version, bytes('04010000000000000001'), groups],
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
    {...item, key: MASTER.index},
    {...item, index: '0f010000000000000000'},
  ]) {
    applet.calls.length = 0;
    await assert.rejects(readCardDerivationRecord(applet, invalid));
    assert.equal(applet.calls.length, 0);
  }

  applet.items.get(item.index).data = recordItem(MASTER).data;
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

  const result = await writeCardDerivations(
    applet,
    SEED,
    [wallet()],
    controller.signal,
  );
  assert.deepEqual(result.derivationRecord.wallets, [wallet()]);
  assert.equal(applet.items.size, 1);
});
