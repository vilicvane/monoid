import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  formatCardResourceCount,
  getCardResourceGroups,
} from '../.bld/app/@components/views/safe/card-resource-groups.js';

const SEED_INDEX = '02400000000000000001';
const MASTER_INDEX = '03200000000000000001';
const seed = Object.freeze({index: SEED_INDEX, type: 'seed'});
const master = Object.freeze({index: MASTER_INDEX, type: 'master'});

function record(index, sourceIndex) {
  return Object.freeze({
    index,
    type: 0x0f01,
    derivationRecord: Object.freeze({index: sourceIndex, wallets: []}),
  });
}

test('an empty card has no resource groups', () => {
  assert.deepEqual(getCardResourceGroups([]), []);
});

test('attached records follow their source without changing representative order', () => {
  const seedRecord = record('0f010000000000000001', SEED_INDEX);
  const masterRecord = record('0f010000000000000002', MASTER_INDEX);
  const ordinary = Object.freeze({index: '12340000000000000003'});
  const resources = Object.freeze([
    masterRecord,
    ordinary,
    seed,
    seedRecord,
    master,
  ]);

  const groups = getCardResourceGroups(resources);

  assert.deepEqual(groups, [
    {item: ordinary, items: [ordinary]},
    {item: seed, items: [seed, seedRecord]},
    {item: master, items: [master, masterRecord]},
  ]);
  assert.equal(groups[1].item, seed);
  assert.equal(groups[2].items[1], masterRecord);
  assert.deepEqual(resources, [
    masterRecord,
    ordinary,
    seed,
    seedRecord,
    master,
  ]);
});

test('a record with no source on this card stays independently selectable', () => {
  const orphan = record('0f010000000000000002', MASTER_INDEX);

  assert.deepEqual(getCardResourceGroups([seed, orphan]), [
    {item: seed, items: [seed]},
    {item: orphan, items: [orphan]},
  ]);
});

test('an arbitrary lookup key or unparsed app type does not imply an attachment', () => {
  const ordinary = {index: '12340000000000000003', key: SEED_INDEX};
  const unparsed = {
    index: '0f010000000000000001',
    type: 0x0f01,
    key: SEED_INDEX,
  };

  assert.deepEqual(getCardResourceGroups([seed, ordinary, unparsed]), [
    {item: seed, items: [seed]},
    {item: ordinary, items: [ordinary]},
    {item: unparsed, items: [unparsed]},
  ]);
});

test('the complete source index distinguishes seed and master with the same index suffix', () => {
  const seedRecord = record('0f010000000000000001', SEED_INDEX);
  const masterRecord = record('0f010000000000000002', MASTER_INDEX);

  assert.deepEqual(
    getCardResourceGroups([seed, master, masterRecord, seedRecord]),
    [
      {item: seed, items: [seed, seedRecord]},
      {item: master, items: [master, masterRecord]},
    ],
  );
});

test('native address records, including empty ones, attach to their supported raw key', () => {
  for (const [type, index] of [
    ['secp256k1', '04010000000000000001'],
    ['ed25519', '05010000000000000001'],
  ]) {
    const raw = {index, type};
    const attached = record('0f010000000000000001', index);

    assert.deepEqual(getCardResourceGroups([attached, raw]), [
      {item: raw, items: [raw, attached]},
    ]);
    assert.equal(
      formatCardResourceCount(getCardResourceGroups([raw, attached])),
      '1+1',
    );
  }
});

test('P-256 does not attach wallet address records', () => {
  const raw = {index: '04020000000000000001', type: 'secp256r1'};
  const unrelated = record('0f010000000000000001', raw.index);

  assert.deepEqual(getCardResourceGroups([raw, unrelated]), [
    {item: raw, items: [raw]},
    {item: unrelated, items: [unrelated]},
  ]);
});

test('counts without attachments retain the ordinary count and progress form', () => {
  const groups = getCardResourceGroups([seed, master]);

  assert.equal(formatCardResourceCount([]), '0');
  assert.equal(
    formatCardResourceCount([], () => true),
    '0/0',
  );
  assert.equal(formatCardResourceCount(groups), '2');
  assert.equal(
    formatCardResourceCount(groups, item => item === seed),
    '1/2',
  );
});

test('selection counts distinguish attached records while transfer progress combines them', () => {
  const seedRecord = record('0f010000000000000001', SEED_INDEX);
  const masterRecord = record('0f010000000000000002', MASTER_INDEX);
  const groups = getCardResourceGroups([
    seed,
    master,
    masterRecord,
    seedRecord,
  ]);

  assert.equal(formatCardResourceCount(groups), '2+2');
  assert.equal(
    formatCardResourceCount(groups, () => false),
    '0/4',
  );
  assert.equal(
    formatCardResourceCount(groups, item => item === seed),
    '1/4',
  );
  assert.equal(
    formatCardResourceCount(groups, item => item !== masterRecord),
    '3/4',
  );
  assert.equal(
    formatCardResourceCount(groups, () => true),
    '4/4',
  );
});

test('an orphan record contributes to the primary count', () => {
  const linked = record('0f010000000000000001', SEED_INDEX);
  const orphan = record('0f010000000000000002', MASTER_INDEX);
  const groups = getCardResourceGroups([seed, linked, orphan]);

  assert.equal(formatCardResourceCount(groups), '2+1');
  assert.equal(
    formatCardResourceCount(groups, item => item === orphan),
    '1/3',
  );
});
