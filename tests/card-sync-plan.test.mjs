import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createCardSyncPlans} from '../.bld/app/@components/views/safe/@card/card-sync-plan.js';
import {
  encodeCardDerivationRecord,
  getCardDerivationItemIndex,
} from '../.bld/app/@components/views/safe/card-derivations.js';

import {credential} from './helpers/security-key-credential.mjs';

const keyIndex = '03010000000000000001';
const publicIndex = '10000000000000000001';
const hex = bytes => Buffer.from(bytes).toString('hex');

function card(id, bundle, items) {
  return {
    id: `0000000${id}`,
    publicKey: `04${String(id).repeat(128)}`,
    bundle,
    items,
  };
}

function secret(overrides = {}) {
  return {
    index: keyIndex,
    type: 'secp256k1',
    secret: true,
    fingerprint: 'key:1',
    exported: {data: 'aa'},
    ...overrides,
  };
}

function records(wallets) {
  const derivationRecord = {
    index: keyIndex,
    wallets: wallets.map(addressType => ({addressType})),
  };
  return {
    index: getCardDerivationItemIndex(keyIndex),
    type: 0x0f01,
    secret: false,
    metadata: keyIndex,
    data: hex(encodeCardDerivationRecord(derivationRecord)),
    derivationRecord,
  };
}

test('OTP metadata follows its HMAC secret scope and imports after that secret', () => {
  const hmac = {
    index: '05140000000000000001',
    type: 'hmac',
    secret: true,
    exported: {data: 'aa'},
  };
  const account = {
    index: 'f2010000000000000001',
    secret: false,
    metadata: '010106001e',
    data: hmac.index,
    otpKeyIndex: hmac.index,
  };
  const plans = createCardSyncPlans([
    card(1, 'A', [account, hmac]),
    card(2, 'A', []),
    card(3, 'B', []),
    card(4, false, []),
  ]);
  assert.deepEqual(
    plans[1].operations.map(operation => [
      operation.kind,
      operation.after.index,
    ]),
    [
      ['import', hmac.index],
      ['create', account.index],
    ],
  );
  assert.deepEqual(plans[2].items, []);
  assert.deepEqual(plans[3].items, []);

  const isolated = createCardSyncPlans([
    card(1, false, [account, {...hmac, exported: undefined}]),
    card(2, false, []),
  ]);
  assert.deepEqual(isolated[1].items, []);
  assert.throws(
    () => createCardSyncPlans([card(1, 'A', [account]), card(2, 'A', [])]),
    /associated key is missing/,
  );
  assert.throws(
    () =>
      createCardSyncPlans([
        card(1, 'A', [account, {...hmac, secret: false, data: 'aa'}]),
      ]),
    /invalid OTP key/,
  );
  assert.throws(
    () =>
      createCardSyncPlans([
        card(1, 'A', [account, hmac]),
        card(2, 'A', [{...account, metadata: '010108001e'}, hmac]),
      ]),
    /conflicting item metadata/,
  );
});

test('public data crosses groups while Secret and address unions stay inside each bundle', () => {
  const cards = [
    card(1, 'A', [
      secret({alias: ''}),
      records(['evm']),
      {index: publicIndex, secret: false, data: 'aa'},
    ]),
    card(2, 'A', [secret({alias: 'Ethereum'}), records(['bitcoin-taproot'])]),
    card(3, 'B', [
      secret({fingerprint: 'key:2', metadata: '01', alias: 'Separate'}),
      records(['bitcoin-segwit']),
    ]),
    card(4, false, [
      secret({fingerprint: 'key:3', metadata: '02'}),
      records(['evm']),
    ]),
    card(5, false, []),
  ];
  const plans = createCardSyncPlans(cards);
  assert.deepEqual(
    plans[0].items
      .find(item => item.derivationRecord)
      .derivationRecord.wallets.map(item => item.addressType),
    ['evm', 'bitcoin-taproot'],
  );
  assert.equal(
    plans[0].items.find(item => item.index === keyIndex).alias,
    'Ethereum',
  );
  assert.equal(
    plans[2].items.find(item => item.index === keyIndex).alias,
    'Separate',
  );
  assert.equal(
    plans[2].items.find(item => item.derivationRecord).derivationRecord.wallets
      .length,
    1,
  );
  assert.equal(
    plans[3].items.find(item => item.derivationRecord).derivationRecord.wallets
      .length,
    1,
  );
  assert.deepEqual(
    plans[4].items.map(item => item.index),
    [publicIndex],
  );
});

test('first opaque data wins, first nonempty alias wins, and absent items do not delete', () => {
  const first = {index: publicIndex, secret: false, data: 'aa', alias: '  '};
  const second = {...first, data: 'bb', alias: 'Named'};
  const third = {...first, data: 'cc', alias: 'Later'};
  const plans = createCardSyncPlans([
    card(1, false, [first]),
    card(2, false, [second]),
    card(3, false, [third]),
  ]);
  assert.equal(plans[0].items[0].data, 'aa');
  assert.equal(plans[0].items[0].alias, 'Named');
  assert.deepEqual(
    plans[0].operations.map(item => item.kind),
    ['alias'],
  );
  assert.deepEqual(
    plans[2].operations.map(item => item.kind),
    ['data', 'alias'],
  );
  assert.equal(first.alias, '  ', 'planning must not mutate observations');
});

test('Secret import retains authenticated metadata and applies merged alias afterwards', () => {
  const plans = createCardSyncPlans([
    card(1, 'A', [
      secret({alias: '', exported: {alias: '', data: 'aa'}}),
      records(['evm']),
    ]),
    card(2, 'A', [secret({alias: 'Named'}), records(['bitcoin-taproot'])]),
    card(3, 'A', []),
  ]);
  const ops = plans[2].operations;
  assert.deepEqual(
    ops.map(item => item.kind),
    ['import', 'alias', 'create'],
  );
  assert.equal(ops[0].after.alias, '');
  assert.equal(ops[0].exported.alias, '');
  assert.equal(ops[1].after.alias, 'Named');
  assert.equal(ops[2].after.derivationRecord.wallets.length, 2);
});

test('opaque Secret verification reads exposed fields, while differing aliases or fingerprints stop planning', () => {
  const pair = (a, b) => [card(1, 'A', [a]), card(2, 'A', [b])];
  const plans = createCardSyncPlans(
    pair(
      secret({fingerprint: undefined, exported: {data: 'aa'}}),
      secret({fingerprint: undefined, exported: {data: 'bb'}}),
    ),
  );
  assert.deepEqual(
    plans.map(plan => plan.operations[0].kind),
    ['verify', 'verify'],
  );
  assert.ok(plans.every(plan => plan.operations[0].exported === undefined));
  assert.throws(
    () =>
      createCardSyncPlans(
        pair(
          secret({fingerprint: undefined, alias: 'A'}),
          secret({fingerprint: undefined, alias: 'B'}),
        ),
      ),
    /cannot compare Secret/,
  );
  assert.throws(
    () => createCardSyncPlans(pair(secret(), secret({fingerprint: 'other'}))),
    /conflicting Secret/,
  );
  assert.throws(
    () => createCardSyncPlans(pair(secret(), secret({metadata: ''}))),
    /conflicting item metadata/,
  );
});

test('orphan records and a public/private index collision are not silently globalized', () => {
  assert.throws(
    () =>
      createCardSyncPlans([card(1, 'A', [records(['evm'])]), card(2, 'A', [])]),
    /associated key is missing/,
  );
  assert.throws(
    () =>
      createCardSyncPlans([
        card(1, 'A', [secret()]),
        card(2, false, [{index: keyIndex, secret: false, data: 'aa'}]),
      ]),
    /conflicting sync scopes/,
  );
});

test('non-bundle Secrets with the same index remain separate and are never exported to peers', () => {
  const plans = createCardSyncPlans([
    card(1, false, [
      secret({fingerprint: undefined, exported: undefined, metadata: '01'}),
    ]),
    card(2, false, [
      secret({fingerprint: undefined, exported: undefined, metadata: '02'}),
    ]),
  ]);
  assert.deepEqual(
    plans.map(plan => plan.operations.length),
    [0, 0],
  );
});

test('credential records keep independent indices and skip identical shared items', () => {
  const first = credential(1);
  const second = credential(2);
  const plans = createCardSyncPlans([
    card(1, 'A', [first]),
    card(2, 'A', [{...first}, second]),
  ]);
  assert.deepEqual(
    plans[0].operations.map(operation => [
      operation.kind,
      operation.after.index,
    ]),
    [['create', second.index]],
  );
  assert.deepEqual(plans[1].operations, []);
  assert.deepEqual(
    plans[0].items.map(item => item.index),
    [first.index, second.index],
  );
});

test('credential payload conflicts stop planning instead of replacing the later card data', () => {
  const first = credential(1);
  const second = credential(1, {fields: [[6, 'other name']]});
  const data = second.data;
  assert.throws(
    () => createCardSyncPlans([card(1, 'A', [first]), card(2, 'A', [second])]),
    /conflicting credential data/,
  );
  assert.equal(second.data, data);
});

test('different credential scopes coexist across Bundles without moving their Secret seeds', () => {
  const first = credential(1);
  const second = credential(2, {scope: 2});
  const plans = createCardSyncPlans([
    card(1, 'A', [secret(), first]),
    card(2, 'B', [secret({fingerprint: 'key:2'}), second]),
    card(3, false, []),
  ]);
  assert.deepEqual(
    plans.map(plan =>
      plan.items
        .filter(item => item.index.startsWith('f101'))
        .map(item => item.index),
    ),
    [
      [first.index, second.index],
      [first.index, second.index],
      [first.index, second.index],
    ],
  );
  assert.deepEqual(
    plans.map(plan =>
      plan.items.filter(item => item.secret).map(item => item.fingerprint),
    ),
    [['key:1'], ['key:2'], []],
  );
  assert.ok(
    plans.every(plan =>
      plan.operations.every(
        operation => operation.kind === 'create' && !operation.after.secret,
      ),
    ),
  );
});

test('same-index valid credentials with a different scope conflict rather than being grouped', () => {
  assert.throws(
    () =>
      createCardSyncPlans([
        card(1, 'A', [credential(1)]),
        card(2, 'B', [credential(1, {scope: 2})]),
      ]),
    /conflicting item metadata/,
  );
});

test('a lone old or malformed credential is rejected before creating a transfer plan', () => {
  for (const item of [
    credential(1, {fields: [[10, undefined]]}),
    credential(1, {fields: [[10, new Uint8Array(31)]]}),
    credential(1, {metadata: '00'.repeat(64)}),
    credential(1, {secret: true}),
  ]) {
    assert.throws(
      () => createCardSyncPlans([card(1, 'A', [item]), card(2, 'B', [])]),
      /invalid Security Key credential/,
    );
  }
});
