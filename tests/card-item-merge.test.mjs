import assert from 'node:assert/strict';
import {test} from 'node:test';

import {mergeCardItemData} from '../.bld/app/@components/views/safe/card-item-merge.js';
import {CardItemConflictError} from '../.bld/app/@lib/monoid/item-operations.js';

import {credential} from './helpers/security-key-credential.mjs';

test('credential merge retains identical bytes and refuses differing valid payload or scope', () => {
  const first = credential(1);
  const original = structuredClone(first);
  assert.equal(mergeCardItemData(first, {...first}), first);
  for (const next of [
    credential(1, {fields: [[6, 'other name']]}),
    credential(1, {scope: 2}),
  ]) {
    assert.throws(() => mergeCardItemData(first, next), CardItemConflictError);
  }
  assert.deepEqual(first, original);
});

test('opaque old and malformed credentials compare as bytes without decoding', () => {
  for (const item of [
    credential(1, {fields: [[10, undefined]]}),
    credential(1, {data: 'ff'}),
    credential(1, {metadata: 'ff', secret: true, data: undefined}),
  ]) {
    assert.equal(mergeCardItemData(item, {...item, alias: 'Other'}), item);
    assert.throws(
      () => mergeCardItemData(item, {...item, metadata: 'aa'}),
      CardItemConflictError,
    );
  }
});

test('unknown item types conflict on different bytes', () => {
  const item = {...credential(1), index: '10000000000000000001'};
  assert.throws(
    () => mergeCardItemData(item, {...item, data: 'bb'}),
    CardItemConflictError,
  );
});
