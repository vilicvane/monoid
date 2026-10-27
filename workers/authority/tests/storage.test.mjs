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

test('idle touches only extend live sessions, never resurrect logout/expiry, and obey the cap', context => {
  const store = database(context);
  const minute = 60000;
  const cap = 15 * minute;
  store.put('session:live', 'secret', '', 5 * minute);
  assert.equal(store.touchSession('session:live', cap, 4 * minute), true);
  assert.equal(store.get('session:live', 8 * minute), 'secret');
  // A stale concurrent touch must not shorten the newer idle deadline.
  assert.equal(store.touchSession('session:live', cap, 3 * minute), true);
  assert.equal(store.get('session:live', 9 * minute - 1), 'secret');
  assert.equal(store.get('session:live', 9 * minute), null);
  assert.equal(store.touchSession('session:live', cap, 9 * minute), false);

  store.put('session:revoked', 'secret', '', 5 * minute);
  store.remove('session:revoked');
  assert.equal(store.touchSession('session:revoked', cap, minute), false);
  assert.equal(store.get('session:revoked', minute), null);

  store.put('session:capped', 'secret', '', 14 * minute);
  assert.equal(store.touchSession('session:capped', cap, 13 * minute), true);
  assert.equal(store.get('session:capped', cap - 1), 'secret');
  assert.equal(store.touchSession('session:capped', cap, cap), false);
  assert.equal(store.get('session:capped', cap), null);
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
