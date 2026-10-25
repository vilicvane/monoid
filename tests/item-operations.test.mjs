import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createCardKey} from '../.bld/app/@components/views/safe/card-key-create.js';
import {
  CardItemExistsError,
  CardItemNotFoundError,
} from '../.bld/app/@lib/cbor-applet.js';
import {
  CardItemConflictError,
  acceptMatchingItem,
  hasMatchingItem,
  removeItems,
  setItemAlias,
} from '../.bld/app/@lib/monoid/item-operations.js';
import {isOperationCancelled} from '../.bld/app/@lib/operation-cancelled.js';

const index = Uint8Array.from(Buffer.from('10000000000000000001', 'hex'));
const expected = {
  index,
  metadata: Uint8Array.of(1),
  alias: 'Name',
  secret: false,
  data: Uint8Array.of(2),
};
const signal = () => new AbortController().signal;

test('EXISTS on an explicit retry is accepted only after checking stored fields and readable data', async () => {
  const calls = [];
  let stored;
  const lost = new Error('Lost response');
  const applet = {
    async create(request) {
      calls.push('create');
      if (stored) throw new CardItemExistsError({code: 'EXISTS'});
      stored = request;
      throw lost;
    },
    async view() {
      calls.push('view');
      return stored;
    },
    async get() {
      calls.push('get');
      return {data: stored.data};
    },
  };
  const write = async () => {
    try {
      await applet.create(expected);
    } catch (error) {
      await acceptMatchingItem(applet, expected, error, signal());
    }
  };
  await assert.rejects(write(), error => error === lost);
  assert.deepEqual(
    calls,
    ['create'],
    'no read or automatic replay after an uncertain write',
  );
  await write();
  assert.deepEqual(calls, ['create', 'create', 'view', 'get']);
});

for (const [field, value] of [
  ['metadata', undefined],
  ['metadata', new Uint8Array()],
  ['alias', undefined],
  ['alias', ''],
  ['secret', true],
  ['data', Uint8Array.of(3)],
]) {
  test(`EXISTS with different ${field} fails without another mutation`, async () => {
    const stored = {...expected, [field]: value};
    const applet = {
      view: async () => stored,
      get: async () => ({data: stored.data}),
    };
    await assert.rejects(
      acceptMatchingItem(
        applet,
        expected,
        new CardItemExistsError({code: 'EXISTS'}),
        signal(),
      ),
      CardItemConflictError,
    );
  });
}

test('digest-indexed secrets reconcile through View without requesting secret data', async () => {
  const item = {
    ...expected,
    index: Uint8Array.from(Buffer.from('02400000000000000001', 'hex')),
    secret: true,
  };
  await acceptMatchingItem(
    {view: async () => item},
    item,
    new CardItemExistsError({code: 'EXISTS'}),
    signal(),
  );
});

test('only a named NOT_FOUND proves absence and cancellation prevents reconciliation reads', async () => {
  assert.equal(
    await hasMatchingItem(
      {
        view: async () => {
          throw new CardItemNotFoundError({code: 'NOT_FOUND'});
        },
      },
      expected,
    ),
    false,
  );
  const failure = new Error('Tag lost');
  await assert.rejects(
    hasMatchingItem(
      {
        view: async () => {
          throw failure;
        },
      },
      expected,
    ),
    error => error === failure,
  );
  await assert.rejects(
    hasMatchingItem(
      {view: () => assert.fail('cancelled')},
      expected,
      AbortSignal.abort(),
    ),
    {name: 'AbortError'},
  );
});

test('removed false is a completed skip and is reported before cancellation', async () => {
  const pending = new Set([Buffer.from(index).toString('hex')]);
  const controller = new AbortController();
  const results = [];
  await assert.rejects(
    removeItems(
      {
        remove: async () => {
          controller.abort();
          return {removed: false};
        },
      },
      pending,
      controller.signal,
      (...result) => results.push(result),
    ),
    {name: 'AbortError'},
  );
  assert.deepEqual(results, [[Buffer.from(index).toString('hex'), false]]);
  assert.equal(pending.size, 0);
});

test('alias edits map only named missing-item errors and never retry uncertain writes', async () => {
  for (const failure of [
    new CardItemNotFoundError({code: 'NOT_FOUND'}),
    new Error('Tag lost'),
  ]) {
    let calls = 0;
    const applet = {
      set: async request => {
        calls++;
        assert.deepEqual(request, {index, alias: 'Renamed'});
        throw failure;
      },
    };
    await assert.rejects(
      setItemAlias(
        applet,
        Buffer.from(index).toString('hex'),
        'Renamed',
        cause => new Error('wrong card?', {cause}),
      ),
      error =>
        failure instanceof CardItemNotFoundError
          ? error.message === 'wrong card?' && error.cause === failure
          : error === failure,
    );
    assert.equal(calls, 1);
  }
});

test('operation cancellation covers signals, AbortError and credential cancellation only', () => {
  for (const error of [
    {code: 'CANCELLED'},
    {code: 'APP_INACTIVE'},
    new DOMException('Aborted', 'AbortError'),
  ])
    assert.equal(isOperationCancelled(error), true);
  for (const error of [
    null,
    undefined,
    new Error('Tag lost'),
    {code: 'INVALID_PIN'},
    {code: 'AUTHORIZATION_EXPIRED'},
  ])
    assert.equal(isOperationCancelled(error), false);
  assert.equal(
    isOperationCancelled(new Error('late failure'), AbortSignal.abort()),
    true,
  );
});

for (const failure of [
  new CardItemExistsError({code: 'EXISTS'}),
  new Error('Tag lost'),
]) {
  test(`random key creation cannot claim or retry an unknown index: ${failure.message}`, async () => {
    let calls = 0;
    const applet = {
      createRandomKey: async () => {
        calls++;
        throw failure;
      },
    };
    await assert.rejects(
      createCardKey(applet, 'seed', signal(), () =>
        assert.fail('No acknowledged index'),
      ),
      error => error.cause === failure && /rescan card/.test(error.message),
    );
    assert.equal(calls, 1);
  });
}
