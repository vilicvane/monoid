import assert from 'node:assert/strict';
import {test} from 'node:test';

import {writeCardAliases} from '../.bld/app/@components/views/safe/card-alias-update.js';
import {assertSameCard} from '../.bld/app/@lib/monoid/card-identity.js';
import {MonoidWrongCardError} from '../.bld/app/@lib/monoid/index.js';

const FIRST_INDEX = '00010000000000000001';
const SECOND_INDEX = '00010000000000000002';
const CARD = {id: '01234567', publicKey: `04${'12'.repeat(64)}`};
const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));

function hello(card = CARD) {
  return {
    version: 0,
    id: bytes(card.id),
    publicKey: bytes(card.publicKey),
    bundle: false,
    authority: false,
    pins: {access: 5, secret: 5},
  };
}

function createApplet(onSet = async () => {}) {
  const requests = [];
  return {
    requests,
    async set(request) {
      requests.push(request);
      await onSet(request);
    },
  };
}

test('writes selected aliases in order, including an explicit empty alias', async () => {
  const controller = new AbortController();
  const pending = new Map([
    [FIRST_INDEX, 'Primary'],
    [SECOND_INDEX, ''],
  ]);
  const updates = [];
  const applet = createApplet(async () => {
    assert.equal(applet.requests.length, updates.length + 1);
  });

  assertSameCard(hello(), CARD);
  await writeCardAliases(applet, pending, controller.signal, (index, alias) =>
    updates.push([index, alias]),
  );

  assert.deepEqual(applet.requests, [
    {index: bytes(FIRST_INDEX), alias: 'Primary'},
    {index: bytes(SECOND_INDEX), alias: ''},
  ]);
  assert.deepEqual(updates, [
    [FIRST_INDEX, 'Primary'],
    [SECOND_INDEX, ''],
  ]);
  assert.equal(pending.size, 0);
});

for (const [description, otherCard] of [
  [
    'the same ID with a different Safe public key',
    {...CARD, publicKey: `04${'34'.repeat(64)}`},
  ],
  ['a different ID with the same Safe public key', {...CARD, id: '89abcdef'}],
]) {
  test(`rejects ${description} before writing`, async () => {
    const pending = new Map([[FIRST_INDEX, 'Primary']]);
    const applet = createApplet();
    const controller = new AbortController();
    const updates = [];

    await assert.rejects(async () => {
      assertSameCard(hello(otherCard), CARD);
      await writeCardAliases(applet, pending, controller.signal, (...update) =>
        updates.push(update),
      );
    }, MonoidWrongCardError);

    assert.deepEqual(applet.requests, []);
    assert.deepEqual(updates, []);
    assert.deepEqual([...pending], [[FIRST_INDEX, 'Primary']]);
  });
}

test('retry resumes after a partial failure without rewriting acknowledged aliases', async () => {
  const controller = new AbortController();
  const pending = new Map([
    [FIRST_INDEX, 'Primary'],
    [SECOND_INDEX, 'Secondary'],
  ]);
  const failure = new Error('Tag lost');
  const updates = [];
  let failSecond = true;
  const applet = createApplet(async ({index}) => {
    if (Buffer.from(index).toString('hex') === SECOND_INDEX && failSecond) {
      throw failure;
    }
  });
  const onUpdated = (index, alias) => updates.push([index, alias]);

  await assert.rejects(
    writeCardAliases(applet, pending, controller.signal, onUpdated),
    error => error === failure,
  );
  assert.deepEqual(updates, [[FIRST_INDEX, 'Primary']]);
  assert.deepEqual([...pending], [[SECOND_INDEX, 'Secondary']]);

  failSecond = false;
  await writeCardAliases(applet, pending, controller.signal, onUpdated);

  assert.deepEqual(
    applet.requests.map(({index}) => Buffer.from(index).toString('hex')),
    [FIRST_INDEX, SECOND_INDEX, SECOND_INDEX],
  );
  assert.deepEqual(updates, [
    [FIRST_INDEX, 'Primary'],
    [SECOND_INDEX, 'Secondary'],
  ]);
  assert.equal(pending.size, 0);
});

test('cancellation before writing leaves every selected alias pending', async () => {
  const controller = new AbortController();
  controller.abort();
  const pending = new Map([[FIRST_INDEX, 'Primary']]);
  const applet = createApplet();
  const updates = [];

  await assert.rejects(
    writeCardAliases(applet, pending, controller.signal, (...update) =>
      updates.push(update),
    ),
    {code: 'CANCELLED'},
  );

  assert.deepEqual(applet.requests, []);
  assert.deepEqual(updates, []);
  assert.deepEqual([...pending], [[FIRST_INDEX, 'Primary']]);
});

test('a write acknowledged after cancellation is recorded before stopping the batch', async () => {
  const controller = new AbortController();
  const pending = new Map([
    [FIRST_INDEX, 'Primary'],
    [SECOND_INDEX, 'Secondary'],
  ]);
  const applet = createApplet(async () => controller.abort());
  const updates = [];

  await assert.rejects(
    writeCardAliases(applet, pending, controller.signal, (index, alias) =>
      updates.push([index, alias]),
    ),
    {code: 'CANCELLED'},
  );

  assert.deepEqual(applet.requests, [
    {index: bytes(FIRST_INDEX), alias: 'Primary'},
  ]);
  assert.deepEqual(updates, [[FIRST_INDEX, 'Primary']]);
  assert.deepEqual([...pending], [[SECOND_INDEX, 'Secondary']]);
});

test('an unacknowledged write remains pending even if cancellation occurs', async () => {
  const controller = new AbortController();
  const pending = new Map([[FIRST_INDEX, 'Primary']]);
  const failure = new Error('Connection lost before response');
  const applet = createApplet(async () => {
    controller.abort();
    throw failure;
  });
  const updates = [];

  await assert.rejects(
    writeCardAliases(applet, pending, controller.signal, (...update) =>
      updates.push(update),
    ),
    error => error === failure,
  );

  assert.equal(applet.requests.length, 1);
  assert.deepEqual(updates, []);
  assert.deepEqual([...pending], [[FIRST_INDEX, 'Primary']]);
});
