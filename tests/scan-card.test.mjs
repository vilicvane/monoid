import assert from 'node:assert/strict';
import {test} from 'node:test';

import {CBORAppletError} from '../.bld/app/@lib/cbor-applet.js';
import {parseDerivationPath} from '../.bld/app/@lib/bip39.js';
import {ADDRESS_TYPES} from '../.bld/app/@lib/wallet-address.js';
import {
  CARD_DERIVATIONS_TYPE,
  encodeCardDerivationRecord,
  getCardDerivationItemIndex,
} from '../.bld/app/@components/views/safe/card-derivations.js';
import {scanCardItems} from '../.bld/app/@components/views/safe/scan-card.js';

const ROOT = '02000000000000000001';
const MASTER = '03000000000000000001';
const ORPHAN = '02000000000000000002';
const PUBLIC_KEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const TAPROOT_KEY =
  'a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c';
const SOLANA_KEY = '00'.repeat(32);
const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
const hex = value => Buffer.from(value).toString('hex');

function wallet(addressType, path, type = 'seed') {
  const options = ADDRESS_TYPES[addressType];
  return {
    addressType,
    seed: type === 'seed' ? options.seed : undefined,
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
    [0, 2],
    [1, 2],
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

test('scan associates records by the full seed or master index', async () => {
  const seedRecord = metadata(ROOT, [wallet('evm', "m/44'/60'/0'/0/2")]);
  const masterRecord = metadata(MASTER, [
    wallet('solana', "m/44'/501'/3'/0'", 'master'),
  ]);
  const {applet, calls} = createApplet(
    [
      resource(ROOT, 'seed'),
      resource(MASTER, 'master'),
      masterRecord.item,
      seedRecord.item,
    ],
    [seedRecord, masterRecord],
  );

  const items = await scanCardItems(applet, () => {});

  assert.equal(items[0].derivations[0].addressType, 'evm');
  assert.equal(items[1].derivations[0].addressType, 'solana');
  assert.equal(items[1].derivations[0].seed, undefined);
  assert.equal(calls.viewKey[1].type, 'master');
  assert.equal(calls.viewKey[1].derivation.type, 'slip10');
  assert.equal(calls.viewKey[1].derivation.curve, 'ed25519');
  assert.equal(hex(calls.viewKey[1].index), MASTER);
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

test('an empty record keeps a default display address without inventing synced derivations', async () => {
  const record = metadata(ROOT, []);
  const {applet, calls} = createApplet(
    [resource(ROOT, 'seed'), record.item],
    [record],
  );

  const items = await scanCardItems(applet, () => {});

  assert.equal(calls.viewKey.length, 1);
  assert.deepEqual(items[0].derivations, []);
  assert.equal(items[0].ref.path, ADDRESS_TYPES.evm.path(0));
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
