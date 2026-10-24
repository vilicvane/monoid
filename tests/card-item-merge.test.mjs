import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  CardItemMergeConflict,
  mergeCardItemData,
  validateCardCredentialItem,
} from '../.bld/app/@components/views/safe/card-item-merge.js';

import {credential} from './helpers/security-key-credential.mjs';

test('credential merge retains identical bytes and refuses differing valid payload or scope', () => {
  const first = credential(1);
  const original = structuredClone(first);
  assert.equal(mergeCardItemData(first, {...first}), first);
  for (const next of [
    credential(1, {fields: [[6, 'other name']]}),
    credential(1, {scope: 2}),
  ]) {
    assert.throws(() => mergeCardItemData(first, next), CardItemMergeConflict);
  }
  assert.deepEqual(first, original);
});

test('old and malformed credentials are explicitly rejected even without a peer', () => {
  for (const item of [
    credential(1, {fields: [[10, undefined]]}),
    credential(1, {fields: [[10, new Uint8Array(31)]]}),
    credential(1, {metadata: '11'.repeat(32)}),
    credential(1, {metadata: '22'.repeat(64)}),
    credential(1, {index: 'f1010000000000000002'}),
    credential(1, {data: undefined}),
    credential(1, {secret: true}),
    credential(1, {data: 'gg'}),
  ]) {
    assert.throws(
      () => validateCardCredentialItem(item),
      /invalid Security Key credential/,
    );
    assert.throws(
      () => mergeCardItemData(credential(1), item),
      /invalid Security Key credential/,
    );
  }
});

test('unknown item types retain their existing first-payload merge behavior', () => {
  const item = {...credential(1), index: '10000000000000000001'};
  assert.equal(mergeCardItemData(item, {...item, data: 'bb'}), item);
});
