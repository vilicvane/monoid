import assert from 'node:assert/strict';
import {test} from 'node:test';
import {database} from './helpers.mjs';

test('atomic consumption rejects wrong proof, expiry and replay', context => {
  const store = database(context);
  store.put('code', 'secret', 'proof', 100);
  assert.equal(store.take('code', 'wrong', 1), null);
  assert.equal(store.take('code', 'proof', 1), 'secret');
  assert.equal(store.take('code', 'proof', 1), null);
  store.put('expired', 'secret', '', 100);
  assert.equal(store.get('expired', 100), null);
  assert.equal(store.take('expired', '', 100), null);
  assert.equal(store.clean(100), false);
});

test('first policy persists; groups are owner scoped and paginated', context => {
  const store = database(context);
  const owner = {source: 'reown', id: '1'};
  store.group(owner, 'fixed', false, 1);
  assert.equal(store.group(owner, 'fixed', true, 2).allowPeerExtension, false);
  assert.equal(
    store.group({source: 'github-organization', id: '1'}, 'fixed'),
    null,
  );
  for (let i = 0; i < 101; i++)
    store.group(owner, `g${String(i).padStart(3, '0')}`, false);
  const page = store.groups(owner, '');
  assert.equal(page.length, 100);
  assert.equal(store.groups(owner, page.at(-1).name).length, 2);
});
