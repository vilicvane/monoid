import assert from 'node:assert/strict';
import {test} from 'node:test';

import {deleteCardResources} from '../.bld/app/@components/views/safe/card-resource-delete.js';
import {CBORAppletError} from '../.bld/app/@lib/cbor-applet.js';

const ATTACHED_INDEX = '0f010000000000000001';
const ROOT_INDEX = '02400000000000000001';
const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));

function createApplet(onRemove = async () => {}) {
  const requests = [];

  return {
    requests,
    async remove(request) {
      requests.push(request);
      await onRemove(request);
      return {};
    },
  };
}

test('deletes companions before their root and records each ACK before the next command', async () => {
  const pending = new Set([ATTACHED_INDEX, ROOT_INDEX]);
  const deleted = [];
  const applet = createApplet(async () => {
    assert.equal(applet.requests.length, deleted.length + 1);
  });

  await deleteCardResources(
    applet,
    pending,
    new AbortController().signal,
    index => {
      assert.equal(pending.has(index), false);
      deleted.push(index);
    },
  );

  assert.deepEqual(applet.requests, [
    {index: bytes(ATTACHED_INDEX)},
    {index: bytes(ROOT_INDEX)},
  ]);
  assert.deepEqual(deleted, [ATTACHED_INDEX, ROOT_INDEX]);
  assert.equal(pending.size, 0);
});

test('retry resumes after a partial failure without deleting acknowledged resources again', async () => {
  const pending = new Set([ATTACHED_INDEX, ROOT_INDEX]);
  const deleted = [];
  const controller = new AbortController();
  const failure = new Error('Tag lost');
  let failRoot = true;
  const applet = createApplet(async ({index}) => {
    if (Buffer.from(index).toString('hex') === ROOT_INDEX && failRoot) {
      throw failure;
    }
  });
  const onDeleted = index => deleted.push(index);

  await assert.rejects(
    deleteCardResources(applet, pending, controller.signal, onDeleted),
    error => error === failure,
  );
  assert.deepEqual(deleted, [ATTACHED_INDEX]);
  assert.deepEqual([...pending], [ROOT_INDEX]);

  failRoot = false;
  await deleteCardResources(applet, pending, controller.signal, onDeleted);

  assert.deepEqual(applet.requests, [
    {index: bytes(ATTACHED_INDEX)},
    {index: bytes(ROOT_INDEX)},
    {index: bytes(ROOT_INDEX)},
  ]);
  assert.deepEqual(deleted, [ATTACHED_INDEX, ROOT_INDEX]);
  assert.equal(pending.size, 0);
});

test('a lost deletion response is recovered when retry reports NOT_FOUND', async () => {
  const pending = new Set([ATTACHED_INDEX, ROOT_INDEX]);
  const deleted = [];
  const controller = new AbortController();
  const failure = new Error('Connection lost before response');
  const remainingOnCard = new Set(pending);
  let loseResponse = true;
  const applet = createApplet(async ({index}) => {
    const key = Buffer.from(index).toString('hex');

    if (!remainingOnCard.delete(key)) {
      throw new CBORAppletError({code: 'NOT_FOUND'});
    }

    if (loseResponse) {
      loseResponse = false;
      throw failure;
    }
  });
  const onDeleted = index => deleted.push(index);

  await assert.rejects(
    deleteCardResources(applet, pending, controller.signal, onDeleted),
    error => error === failure,
  );
  assert.deepEqual([...pending], [ATTACHED_INDEX, ROOT_INDEX]);
  assert.deepEqual(deleted, []);

  await deleteCardResources(applet, pending, controller.signal, onDeleted);

  assert.deepEqual(deleted, [ATTACHED_INDEX, ROOT_INDEX]);
  assert.equal(pending.size, 0);
  assert.equal(remainingOnCard.size, 0);
  assert.deepEqual(applet.requests, [
    {index: bytes(ATTACHED_INDEX)},
    {index: bytes(ATTACHED_INDEX)},
    {index: bytes(ROOT_INDEX)},
  ]);
});

for (const [name, failure] of [
  ['another card error', new CBORAppletError({code: 'ACCESS_DENIED'})],
  [
    'an unrelated error carrying NOT_FOUND',
    Object.assign(new Error('NOT_FOUND'), {source: {code: 'NOT_FOUND'}}),
  ],
]) {
  test(`does not treat ${name} as a completed deletion`, async () => {
    const pending = new Set([ATTACHED_INDEX, ROOT_INDEX]);
    const deleted = [];
    const applet = createApplet(async () => {
      throw failure;
    });

    await assert.rejects(
      deleteCardResources(
        applet,
        pending,
        new AbortController().signal,
        index => deleted.push(index),
      ),
      error => error === failure,
    );

    assert.deepEqual(applet.requests, [{index: bytes(ATTACHED_INDEX)}]);
    assert.deepEqual([...pending], [ATTACHED_INDEX, ROOT_INDEX]);
    assert.deepEqual(deleted, []);
  });
}

test('cancellation before deletion leaves all resources pending', async () => {
  const pending = new Set([ATTACHED_INDEX, ROOT_INDEX]);
  const deleted = [];
  const controller = new AbortController();
  const applet = createApplet();
  controller.abort();

  await assert.rejects(
    deleteCardResources(applet, pending, controller.signal, index =>
      deleted.push(index),
    ),
    {code: 'CANCELLED'},
  );

  assert.deepEqual(applet.requests, []);
  assert.deepEqual([...pending], [ATTACHED_INDEX, ROOT_INDEX]);
  assert.deepEqual(deleted, []);
});

for (const response of ['ACK', 'NOT_FOUND']) {
  test(`cancellation during ${response} records the deletion before stopping`, async () => {
    const pending = new Set([ATTACHED_INDEX, ROOT_INDEX]);
    const deleted = [];
    const controller = new AbortController();
    const applet = createApplet(async () => {
      controller.abort();

      if (response === 'NOT_FOUND') {
        throw new CBORAppletError({code: 'NOT_FOUND'});
      }
    });

    await assert.rejects(
      deleteCardResources(applet, pending, controller.signal, index =>
        deleted.push(index),
      ),
      {code: 'CANCELLED'},
    );

    assert.deepEqual(applet.requests, [{index: bytes(ATTACHED_INDEX)}]);
    assert.deepEqual([...pending], [ROOT_INDEX]);
    assert.deepEqual(deleted, [ATTACHED_INDEX]);
  });
}

test('an unacknowledged deletion remains pending when cancellation also occurs', async () => {
  const pending = new Set([ATTACHED_INDEX, ROOT_INDEX]);
  const deleted = [];
  const controller = new AbortController();
  const failure = new Error('Connection lost before response');
  const applet = createApplet(async () => {
    controller.abort();
    throw failure;
  });

  await assert.rejects(
    deleteCardResources(applet, pending, controller.signal, index =>
      deleted.push(index),
    ),
    error => error === failure,
  );

  assert.deepEqual(applet.requests, [{index: bytes(ATTACHED_INDEX)}]);
  assert.deepEqual([...pending], [ATTACHED_INDEX, ROOT_INDEX]);
  assert.deepEqual(deleted, []);
});
