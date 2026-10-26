import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

import {encode} from 'cbor2';

import {CardStore} from '../.bld/app/@services/card-store.js';

let exchange;
mock.module('capacitor-isodep-nfc', {
  namedExports: {IsoDepNfc: {transceive: request => exchange(request)}},
});
const {createMonoidApplet} = await import(
  '../.bld/app/@lib/monoid/monoid-applet.js'
);
const {removeItems} = await import(
  '../.bld/app/@lib/monoid/item-operations.js'
);

const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
const index = bytes('f1010000000000000001');
const identity = {id: 'aabbccdd', publicKey: `04${'12'.repeat(64)}`};
const otherIdentity = {...identity, publicKey: `04${'34'.repeat(64)}`};
const hello = card => ({
  version: 1,
  id: bytes(card.id),
  publicKey: bytes(card.publicKey),
  authority: false,
  alias: false,
  allowPeerExtension: false,
  bundle: false,
  pins: {access: 5, secret: 5},
});
const snapshot = card => ({
  ...card,
  bundle: false,
  items: [
    {index: Buffer.from(index).toString('hex'), type: 0xf101, secret: false},
  ],
});
const commands = [
  ['setAlias', 0x27, {alias: 'Travel'}, {}],
  ['create', 0x34, {index, data: Uint8Array.of(1)}, {index}],
  ['set', 0x33, {index, alias: 'Updated'}, {}],
  ['remove', 0x35, {index}, {removed: true}],
  ['importItem', 0x37, {index, data: Uint8Array.of(1)}, {}],
  ['createRandomKey', 0x38, {type: 'seed', length: 64}, {index}],
  [
    'setAppletGrant',
    0x51,
    {aid: bytes('f001020304'), types: [[-3839, true]]},
    {},
  ],
  ['removeAppletGrant', 0x52, {aid: bytes('f001020304')}, {}],
  [
    'createBundle',
    0x23,
    {publicKeys: [bytes(otherIdentity.publicKey)]},
    {bundle: new Uint8Array(32), data: []},
  ],
  [
    'joinBundle',
    0x24,
    {publicKey: bytes(otherIdentity.publicKey), data: Uint8Array.of(1)},
    {bundle: new Uint8Array(32)},
  ],
  ['reset', 0xff, {}, {}],
];

function fixture() {
  const store = new CardStore();
  const current = store.set(snapshot(identity));
  const other = store.set(snapshot(otherIdentity));
  const cards = new Map([
    ['first', hello(identity)],
    ['second', hello(otherIdentity)],
  ]);
  const sent = [];
  const state = {store, current, other, cards, sent};
  exchange = async ({sessionId, data}) => {
    const ins = data[1];
    if (ins === 0xa4) return {data: [0x90, 0]};
    sent.push({sessionId, ins});
    const result =
      ins === 0x20
        ? cards.get(sessionId)
        : (state.respond?.(sessionId, ins) ??
          commands.find(command => command[1] === ins)?.[3] ??
          {});
    return {data: [...encode(result), 0x90, 0]};
  };
  state.root = store.observeApplet(createMonoidApplet());
  state.open = async sessionId => {
    const applet = await state.root.openSession(sessionId);
    await applet.hello({});
    return applet;
  };
  return state;
}

for (const [name, ins, request, response] of commands) {
  test(`${name} invalidates only the greeted card through the real command transport`, async () => {
    const state = fixture();
    const applet = await state.open('first');
    const result = await applet[name](request);
    assert.deepEqual(result, response);
    assert.equal(state.store.get(identity), undefined);
    assert.equal(state.store.get(otherIdentity), state.other);
    assert.equal(
      state.current.items.length,
      1,
      'invalidation leaves owned state intact',
    );
    assert.deepEqual(state.sent, [
      {sessionId: 'first', ins: 0x20},
      {sessionId: 'first', ins},
    ]);
  });
}

test('overlapping sessions retain their own identity and lost acknowledgements never replay', async () => {
  const state = fixture();
  const first = await state.open('first');
  const second = await state.open('second');
  const failure = new Error('Lost acknowledgement');
  state.respond = () => {
    throw failure;
  };
  await assert.rejects(first.remove({index}), error => error === failure);
  assert.equal(state.store.get(identity), undefined);
  assert.equal(state.store.get(otherIdentity), state.other);
  state.respond = undefined;
  await second.remove({index});
  assert.equal(state.store.get(otherIdentity), undefined);
  assert.deepEqual(
    state.sent.filter(command => command.ins === 0x35),
    [
      {sessionId: 'first', ins: 0x35},
      {sessionId: 'second', ins: 0x35},
    ],
  );
});

test('missing deletes remain skips, and cancellation before a write leaves the cache intact', async () => {
  const state = fixture();
  const applet = await state.open('first');
  const pending = new Set([Buffer.from(index).toString('hex')]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    removeItems(applet, pending, controller.signal, () => {}),
    {name: 'AbortError'},
  );
  assert.equal(state.store.get(identity), state.current);
  assert.equal(state.sent.length, 1);

  state.respond = () => ({removed: false});
  await removeItems(applet, pending, new AbortController().signal, () => {});
  assert.equal(pending.size, 0);
  assert.equal(state.store.get(identity), undefined);
});

test('a fresh Hello after reset changes the identity invalidated by subsequent writes', async () => {
  const state = fixture();
  const applet = await state.open('first');
  await applet.reset({});
  assert.equal(state.store.get(identity), undefined);
  state.cards.set('first', hello(otherIdentity));
  await applet.hello({});
  await applet.remove({index});
  assert.equal(state.store.get(otherIdentity), undefined);
});

test('maintenance can bind an already greeted connection without an extra Hello', async () => {
  const state = fixture();
  const raw = await createMonoidApplet().openSession('first');
  const applet = state.store.observeApplet(raw, hello(identity));
  await applet.importItem({index, data: Uint8Array.of(1)});
  assert.equal(state.store.get(identity), undefined);
  assert.deepEqual(state.sent, [{sessionId: 'first', ins: 0x37}]);
});

test('read commands, PIN changes and extension packets leave cached contents intact', async () => {
  const state = fixture();
  const applet = await state.open('first');
  state.respond = (_session, ins) =>
    ({
      0x30: {items: []},
      0x50: {grants: []},
      0x25: {data: Uint8Array.of(1)},
      0x26: {publicKey: bytes(otherIdentity.publicKey), data: Uint8Array.of(1)},
    })[ins] ?? {};
  await applet.list({});
  await applet.listAppletGrants({});
  await applet.authenticate({pin: '123456'});
  await applet.setPIN({pin: '654321'});
  await applet.extendBundle({publicKey: bytes(otherIdentity.publicKey)});
  await applet.approveBundleExtension({data: Uint8Array.of(1)});
  assert.equal(state.store.get(identity), state.current);
});

test('an owner can publish its acknowledged state and a later failed write invalidates it again', async () => {
  const state = fixture();
  const applet = await state.open('first');
  const originalItem = state.current.items[0];
  await applet.set({index, alias: 'Updated'});
  state.current.upsert({...originalItem, alias: 'Updated'});
  state.store.set(state.current);
  assert.equal(state.store.get(identity), state.current);
  assert.equal(state.current.items[0], originalItem);
  assert.equal(originalItem.alias, 'Updated');
  state.respond = () => {
    throw new Error('Lost acknowledgement');
  };
  await assert.rejects(applet.remove({index}), /Lost acknowledgement/);
  assert.equal(state.store.get(identity), undefined);
  assert.equal(originalItem.alias, 'Updated');
});
