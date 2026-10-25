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

test('OTP sync uses a single secret item scoped to its Bundle', () => {
  const account = {
    index: 'f2010000000000000001',
    secret: true,
    metadata: '010106001e',
    exported: {metadata: '010106001e', data: 'aa'},
  };
  const plans = createCardSyncPlans([
    card(1, 'A', [account]),
    card(2, 'A', []),
    card(3, 'B', []),
    card(4, false, []),
  ]);
  assert.deepEqual(
    plans[1].operations.map(operation => [
      operation.kind,
      operation.after.index,
    ]),
    [['import', account.index]],
  );
  assert.deepEqual(plans[2].items, []);
  assert.deepEqual(plans[3].items, []);
  const isolated = createCardSyncPlans([
    card(1, false, [{...account, exported: undefined}]),
    card(2, false, []),
  ]);
  assert.deepEqual(isolated[1].items, []);
  const opaque = createCardSyncPlans([
    card(1, 'A', [{...account, secret: false, data: 'aa'}]),
    card(2, 'A', []),
  ]);
  assert.equal(opaque[1].operations[0].after.data, 'aa');
  const conflicts = createCardSyncPlans([
    card(1, 'A', [account]),
    card(2, 'A', [{...account, metadata: 'ff'}]),
  ]);
  assert.ok(
    conflicts.every(
      plan =>
        plan.issues[0].reason === 'Conflict' && plan.operations.length === 0,
    ),
  );
});

test('OTP digest indices allow alias merging without comparing ciphertext or importing existing items', () => {
  const account = {
    index: 'f2010000000000000001',
    secret: true,
    metadata: '010106001e',
    alias: 'First',
  };
  const plans = createCardSyncPlans([
    card(1, 'A', [{...account, exported: {...account, data: 'aa'}}]),
    card(2, 'A', [
      {
        ...account,
        alias: 'Second',
        exported: {...account, alias: 'Second', data: 'bb'},
      },
    ]),
  ]);
  assert.deepEqual(plans[0].operations, []);
  assert.deepEqual(
    plans[1].operations.map(operation => [
      operation.kind,
      operation.after.alias,
    ]),
    [['alias', 'First']],
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

test('different opaque data conflicts only on its index; equal data merges aliases', () => {
  const first = {index: publicIndex, secret: false, data: 'aa', alias: '  '};
  const second = {...first, alias: 'Named'};
  const third = {...first, alias: 'Later'};
  const plans = createCardSyncPlans([
    card(1, false, [first]),
    card(2, false, [second]),
    card(3, false, [third]),
  ]);
  assert.equal(plans[0].items[0].alias, 'Named');
  assert.deepEqual(
    plans[2].operations.map(item => item.kind),
    ['alias'],
  );
  assert.equal(first.alias, '  ');
  const conflicts = createCardSyncPlans([
    card(1, false, [first, credential(1)]),
    card(2, false, [{...second, data: 'bb'}]),
    card(3, false, []),
  ]);
  assert.ok(
    conflicts.every(plan =>
      plan.issues.some(issue => issue.index === publicIndex),
    ),
  );
  assert.deepEqual(
    conflicts[2].operations.map(op => op.after.index),
    [credential(1).index],
  );
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

test('opaque Secret equality ignores ciphertext and merges aliases using exposed fields', () => {
  const first = secret({alias: 'A', exported: {data: 'aa'}});
  const second = secret({alias: 'B', exported: {data: 'bb'}});
  const plans = createCardSyncPlans([
    card(1, 'A', [first]),
    card(2, 'A', [second]),
  ]);
  assert.deepEqual(plans[0].operations, []);
  assert.deepEqual(
    plans[1].operations.map(op => op.kind),
    ['alias'],
  );
  const conflicts = createCardSyncPlans([
    card(1, 'A', [first]),
    card(2, 'A', [{...second, metadata: ''}]),
  ]);
  assert.ok(conflicts.every(plan => plan.issues[0].reason === 'Conflict'));
});

test('orphan records remain opaque while scope collisions are per-item conflicts', () => {
  const orphan = createCardSyncPlans([
    card(1, 'A', [records(['evm'])]),
    card(2, 'A', []),
  ]);
  assert.equal(orphan[1].operations[0].kind, 'create');
  const plans = createCardSyncPlans([
    card(1, 'A', [secret()]),
    card(2, false, [{index: keyIndex, secret: false, data: 'aa'}]),
  ]);
  assert.equal(plans[0].issues[0].reason, 'Conflict');
  assert.deepEqual(plans[0].operations, []);
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

test('credential conflicts preserve both copies and allow unrelated creates', () => {
  const first = credential(1),
    second = credential(1, {fields: [[6, 'other name']]});
  const plans = createCardSyncPlans([
    card(1, 'A', [first, credential(2)]),
    card(2, 'A', [second]),
  ]);
  assert.ok(plans.every(plan => plan.issues[0].index === first.index));
  assert.deepEqual(
    plans[1].operations.map(op => op.after.index),
    [credential(2).index],
  );
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

test('same-index credential metadata conflicts across Bundles', () => {
  const plans = createCardSyncPlans([
    card(1, 'A', [credential(1)]),
    card(2, 'B', [credential(1, {scope: 2})]),
  ]);
  assert.ok(
    plans.every(
      plan => plan.issues[0].reason === 'Conflict' && !plan.operations.length,
    ),
  );
});

test('old and undecodable public credentials produce opaque transfer plans', () => {
  for (const item of [
    credential(1, {fields: [[10, undefined]]}),
    credential(1, {data: 'ff'}),
    credential(1, {metadata: 'ff'}),
  ]) {
    const plans = createCardSyncPlans([card(1, 'A', [item]), card(2, 'B', [])]);
    assert.deepEqual(plans[1].operations[0].after, item);
    assert.deepEqual(plans[1].issues, []);
  }
});
