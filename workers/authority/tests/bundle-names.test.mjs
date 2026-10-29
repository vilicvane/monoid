import assert from 'node:assert/strict';
import {createECDH} from 'node:crypto';
import {test} from 'node:test';
import {setup} from './login-fixture.mjs';

async function setupBundle(t) {
  const f = setup(t);
  const session = await f.login();
  const owner = {source: session.account.source, id: session.account.id};
  const recipient = createECDH('prime256v1');
  recipient.generateKeys();
  const input = {
    owner,
    allowPeerExtension: false,
    recipientPublicKey: recipient.getPublicKey().toString('base64url'),
  };
  return {
    f,
    owner,
    issue: changes =>
      f.call('/v1/bundle', {...input, ...changes}, session.accessToken),
    list: changes =>
      f.call('/v1/groups/list', {owner, ...changes}, session.accessToken),
    rename: changes =>
      f.call('/v1/namespaces/name', {owner, ...changes}, session.accessToken),
  };
}

test('omitted and empty names identify one unnamed bundle with its own immutable policy', async t => {
  const {issue, list} = await setupBundle(t);
  const first = await issue({});
  assert.equal(first.status, 200);
  const unnamed = await first.json();
  assert.equal(unnamed.groupName, '');
  const repeated = await issue({groupName: ''});
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).bundle, unnamed.bundle);
  const named = await issue({groupName: 'treasury', allowPeerExtension: true});
  assert.equal(named.status, 200);
  assert.notEqual((await named.json()).bundle, unnamed.bundle);
  for (const changes of [
    {allowPeerExtension: true},
    {groupName: '', allowPeerExtension: true},
    {groupName: 'treasury'},
  ]) {
    const response = await issue(changes);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {error: 'bundle_policy_conflict'});
  }
  const response = await list({});
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.deepEqual(
    page.groups.map(({name, allowPeerExtension}) => ({
      name,
      allowPeerExtension,
    })),
    [
      {name: '', allowPeerExtension: false},
      {name: 'treasury', allowPeerExtension: true},
    ],
  );
});

test('non-empty bundle validation and required namespace display names stay strict', async t => {
  const {issue, rename} = await setupBundle(t);
  for (const groupName of [
    null,
    false,
    0,
    [],
    {},
    ' ',
    ' treasury',
    'treasury ',
    '\t',
    'a\nb',
    'a\u200bb',
    'a'.repeat(129),
    'é'.repeat(65),
  ]) {
    assert.equal(
      (await issue({groupName})).status,
      400,
      JSON.stringify(groupName),
    );
  }
  const decomposed = await issue({groupName: 'e\u0301'});
  assert.equal(decomposed.status, 200);
  const normalized = await decomposed.json();
  assert.equal(normalized.groupName, 'é');
  assert.equal(
    (await (await issue({groupName: 'é'})).json()).bundle,
    normalized.bundle,
  );
  assert.equal((await issue({groupName: 'é'.repeat(64)})).status, 200);
  assert.equal((await issue({groupName: 'a'.repeat(128)})).status, 200);
  for (const changes of [
    {},
    {displayName: ''},
    {displayName: null},
    {displayName: ' '},
  ])
    assert.equal((await rename(changes)).status, 400);
  const renamed = await rename({displayName: 'e\u0301'});
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).namespace.displayName, 'é');
});

test('list start and the cursor immediately after the unnamed bundle are distinct, including full pages', async t => {
  const {f, owner, list} = await setupBundle(t);
  f.store.group(owner, '', false);
  f.store.group(owner, 'treasury', true);
  const start = await (await list({})).json();
  assert.deepEqual(
    start.groups.map(group => group.name),
    ['', 'treasury'],
  );
  // Explicit page boundary immediately after the unnamed bundle: never restart
  // or repeat it when the cursor's string value is empty.
  const afterUnnamed = await (await list({after: ''})).json();
  assert.deepEqual(
    afterUnnamed.groups.map(group => group.name),
    ['treasury'],
  );
  assert.equal(afterUnnamed.next, null);
  assert.deepEqual((await (await list({after: 'treasury'})).json()).groups, []);
  for (const after of [null, 0, ' ', '\u200b'])
    assert.equal((await list({after})).status, 400);
  const names = Array.from(
    {length: 100},
    (_, i) => `n${String(i).padStart(3, '0')}`,
  );
  for (const name of names) f.store.group(owner, name, false);
  f.store.group({...owner, id: 'another-owner'}, 'other', false);
  const first = await (await list({})).json();
  assert.equal(first.groups.length, 100);
  assert.equal(first.groups[0].name, '');
  assert.equal(first.next, 'n098');
  const second = await (await list({after: first.next})).json();
  assert.equal(second.next, null);
  assert.deepEqual(
    [...first.groups, ...second.groups].map(group => group.name),
    ['', ...names, 'treasury'],
  );
  const namedFirst = await (await list({after: ''})).json();
  assert.deepEqual(
    namedFirst.groups.map(group => group.name),
    names,
  );
  assert.equal(namedFirst.next, 'n099');
  f.store.group(owner, 'é', false);
  f.store.group(owner, 'être', false);
  assert.deepEqual(
    (await (await list({after: 'e\u0301'})).json()).groups.map(
      group => group.name,
    ),
    ['être'],
  );
});
