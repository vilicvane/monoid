import assert from 'node:assert/strict';
import {test} from 'node:test';

import {CardSyncSession} from '../.bld/app/@components/views/safe/@card/card-sync-session.js';
import {
  encodeCardDerivationRecord,
  getCardDerivationItemIndex,
} from '../.bld/app/@components/views/safe/card-derivations.js';
import {AppletISOError} from '../.bld/app/@lib/applet.js';
import {CBORAppletError} from '../.bld/app/@lib/cbor-applet.js';

const PIN = 'Secret-42';
const signal = () => new AbortController().signal;
const bytes = value => Uint8Array.from(Buffer.from(value, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const keyIndex = '03010000000000000001';
const publicIndex = '10000000000000000001';
const unknownIndex = '10000000000000000002';

function mockCard(id, bundle = false, entries = []) {
  const records = new Map(
    entries.map(entry => [entry.index, structuredClone(entry)]),
  );
  const calls = [];
  const card = {
    records,
    calls,
    hello: {
      version: 1,
      id: bytes(`0000000${id}`),
      publicKey: Uint8Array.from([4, ...new Array(64).fill(id)]),
      bundle: bundle === false ? false : new Uint8Array(32).fill(bundle),
      pins: {access: 5, secret: 5},
    },
    async authenticate({secret, pin}) {
      calls.push(['authenticate', {secret, pin}]);
      assert.equal(secret, true);
      assert.equal(pin, PIN);
    },
    async list() {
      calls.push(['list']);
      return {
        items: [...records.values()].map(
          ({index, type, alias, key, secret}) => ({
            index: bytes(index),
            type,
            alias,
            key: key === undefined ? undefined : bytes(key),
            secret,
          }),
        ),
      };
    },
    async view({index}) {
      const value = hex(index);
      calls.push(['view', value]);
      const item = records.get(value);
      if (!item) throw new CBORAppletError({code: 'NOT_FOUND'});
      return {
        key: item.key === undefined ? undefined : bytes(item.key),
        alias: item.alias,
        secret: item.secret,
      };
    },
    async get({index}) {
      const item = records.get(hex(index));
      calls.push(['get', item.index]);
      assert.equal(
        item.secret,
        false,
        'Secret plaintext must never be requested',
      );
      return {data: bytes(item.data)};
    },
    async viewKey({index, type}) {
      const item = records.get(hex(index));
      calls.push(['viewKey', item.index]);
      return {
        publicKey: bytes(`04${item.data.padEnd(128, '0').slice(0, 128)}`),
        ...(type === 'seed' && {
          chainCode: bytes(item.chainCode ?? '11'.repeat(32)),
        }),
      };
    },
    async exportItem({index}) {
      const item = records.get(hex(index));
      calls.push(['export', item.index]);
      return {
        key: item.key === undefined ? undefined : bytes(item.key),
        alias: item.alias,
        data: new TextEncoder().encode(
          JSON.stringify({sender: hex(card.hello.publicKey), item}),
        ),
      };
    },
    async importItem(request) {
      const {sender, item: incoming} = JSON.parse(
        new TextDecoder().decode(request.data),
      );
      assert.notEqual(
        sender,
        hex(card.hello.publicKey),
        'Bundle imports must use another member',
      );
      calls.push(['import', incoming.index]);
      assert.equal(hex(request.index), incoming.index);
      assert.equal(
        request.alias,
        incoming.alias,
        'Import must preserve authenticated alias',
      );
      assert.equal(
        request.key === undefined ? undefined : hex(request.key),
        incoming.key,
      );
      const existing = records.get(incoming.index);
      if (existing) {
        try {
          assert.deepEqual(existing, incoming);
        } catch {
          throw new AppletISOError(
            'Conflicting data',
            0x6985,
            new Uint8Array(),
          );
        }
      } else {
        await card.beforeMutation?.('import', incoming);
        records.set(incoming.index, incoming);
        await card.afterMutation?.('import', incoming);
      }
      return {};
    },
    async create(request) {
      const index = hex(request.index);
      calls.push(['create', index]);
      assert.equal(
        records.has(index),
        false,
        'Create must not replay after a lost ACK',
      );
      const item = {
        index,
        key: request.key === undefined ? undefined : hex(request.key),
        alias: request.alias,
        secret: false,
        data: hex(request.data),
      };
      await card.beforeMutation?.('create', item);
      records.set(index, item);
      await card.afterMutation?.('create', item);
      return {index: request.index};
    },
    async set(request) {
      const index = hex(request.index);
      const item = records.get(index);
      calls.push(['set', index]);
      await card.beforeMutation?.('set', request);
      if (request.data !== undefined) item.data = hex(request.data);
      if (request.alias !== undefined) item.alias = request.alias;
      await card.afterMutation?.('set', request);
      return {};
    },
  };
  return card;
}

const root = (overrides = {}) => ({
  index: keyIndex,
  type: 'secp256k1',
  secret: true,
  data: '12',
  ...overrides,
});
const plain = (overrides = {}) => ({
  index: publicIndex,
  secret: false,
  data: 'aa',
  ...overrides,
});
const add = (session, card, pin = PIN) =>
  session.add(card, card.hello, signal(), pin);
const write = (session, card, pin = PIN) =>
  session.write(card, card.hello, signal(), pin);
const mutationCalls = card =>
  card.calls.filter(([kind]) => ['create', 'set', 'import'].includes(kind));

test('missing Secret PIN stops before reading or exporting card contents', async () => {
  const session = new CardSyncSession();
  const card = mockCard(1, 1, [root()]);
  await assert.rejects(
    session.add(card, card.hello, signal()),
    /Enter Secret PIN/,
  );
  assert.equal(session.cards.length, 0);
  assert.deepEqual(card.calls, []);
  await add(session, card, PIN);
  assert.equal(session.confirmedSnapshot.items[0].secret, true);
  assert.equal(session.confirmedSnapshot.items[0].data, undefined);
});

for (const access of [false, 0]) {
  test(`public-only collection uses Secret authentication with Access PIN ${access}`, async () => {
    const session = new CardSyncSession();
    const card = mockCard(1, false, [plain()]);
    card.hello.pins.access = access;
    await add(session, card);
    assert.deepEqual(card.calls, [
      ['authenticate', {secret: true, pin: PIN}],
      ['list'],
      ['get', publicIndex],
    ]);
    assert.equal(session.cards[0].items[0].data, 'aa');
  });
}

test('collection stops before reading when Secret PIN is unset or blocked', async () => {
  const session = new CardSyncSession();
  const card = mockCard(1, false, [plain()]);
  card.hello.pins.secret = false;
  await assert.rejects(add(session, card), /Secret PIN not set/);
  card.hello.pins.secret = 0;
  await assert.rejects(add(session, card), /Secret PIN blocked/);
  assert.deepEqual(card.calls, []);
  assert.equal(session.cards.length, 0);
});

test('collection never reads after authentication fails or is cancelled', async () => {
  const session = new CardSyncSession();
  const card = mockCard(1, false, [plain()]);
  const failure = new Error('Authentication rejected');
  card.authenticate = async () => {
    throw failure;
  };
  await assert.rejects(add(session, card), error => error === failure);
  const abort = new AbortController();
  card.authenticate = async () => {
    abort.abort();
  };
  await assert.rejects(
    session.add(card, card.hello, abort.signal, PIN),
    error => error.code === 'CANCELLED',
  );
  assert.deepEqual(card.calls, []);
  assert.equal(session.cards.length, 0);
});

test('refresh preserves first-card priority and no-op completion clears temporary payloads', async () => {
  const session = new CardSyncSession();
  const first = mockCard(1, false, [plain({alias: 'First'})]);
  const second = mockCard(2, false, [plain({alias: 'First'})]);
  await add(session, first);
  await add(session, second);
  await add(session, first);
  assert.deepEqual(
    session.cards.map(card => card.id),
    ['00000001', '00000002'],
  );
  assert.equal(session.noSyncRequired, true);
  assert.equal(session.phase, 'collect');
  assert.equal(session.cards[0].items[0].data, 'aa');
  session.prepare();
  assert.equal(session.phase, 'complete');
  assert.equal(session.cards[0].items[0].data, undefined);
});

test('normal writes use the collected snapshot and complete without rereading the card', async () => {
  const session = new CardSyncSession();
  const first = mockCard(1, false, [plain()]);
  const target = mockCard(2, false);
  await add(session, first);
  await add(session, target);
  session.prepare();
  target.hello.pins.access = 0;
  target.calls.length = 0;
  const stages = [];
  await session.write(target, target.hello, signal(), PIN, progress => {
    stages.push(progress.stage);
  });
  assert.deepEqual(target.calls, [
    ['authenticate', {secret: true, pin: PIN}],
    ['create', publicIndex],
  ]);
  assert.equal(target.records.get(publicIndex).data, 'aa');
  assert.equal(session.phase, 'complete');
  assert.ok(stages.length > 0);
  assert.ok(stages.every(stage => stage === 'writing'));
});

test('completed and unchanged cards return without issuing any commands or checking PIN status', async () => {
  const session = new CardSyncSession();
  const first = mockCard(1, false, [plain()]);
  const target = mockCard(2, false);
  await add(session, first);
  await add(session, target);
  session.prepare();
  first.hello.pins = {access: 0, secret: 0};
  first.calls.length = 0;
  assert.equal(
    (await session.write(first, first.hello, signal())).complete,
    true,
  );
  assert.deepEqual(first.calls, []);
  await write(session, target);
  target.hello.pins = {access: false, secret: false};
  target.calls.length = 0;
  assert.equal(
    (await session.write(target, target.hello, signal())).complete,
    true,
  );
  assert.deepEqual(target.calls, []);
});

test('unfinished cards with unset or blocked Secret PIN stop before authentication', async () => {
  const session = new CardSyncSession();
  const first = mockCard(1, false, [plain()]);
  const target = mockCard(2, false);
  await add(session, first);
  await add(session, target);
  session.prepare();
  target.calls.length = 0;
  target.hello.pins.secret = false;
  await assert.rejects(write(session, target), /Secret PIN not set/);
  target.hello.pins.secret = 0;
  await assert.rejects(write(session, target), /Secret PIN blocked/);
  assert.deepEqual(target.calls, []);
});

test('mixed cards sync public data globally, write roots before records, and preserve source alias on import', async () => {
  const session = new CardSyncSession();
  const record = {index: keyIndex, wallets: [{addressType: 'evm'}]};
  const companion = {
    index: getCardDerivationItemIndex(keyIndex),
    type: 0x0f01,
    key: keyIndex,
    secret: false,
    data: hex(encodeCardDerivationRecord(record)),
  };
  const first = mockCard(1, 1, [root({alias: ''}), companion, plain()]);
  const second = mockCard(2, 1, [root({alias: 'Wallet'})]);
  const third = mockCard(3, 1);
  const outside = mockCard(4, false);
  for (const card of [first, second, third, outside])
    await add(session, card, PIN);
  session.prepare();
  for (const card of [first, second, third, outside]) card.calls.length = 0;
  await write(session, third, PIN);
  assert.deepEqual(
    mutationCalls(third).map(([kind]) => kind),
    ['import', 'set', 'create', 'create'],
  );
  assert.equal(third.records.get(keyIndex).alias, 'Wallet');
  assert.ok(third.records.has(companion.index));
  await write(session, outside);
  assert.deepEqual([...outside.records.keys()], [publicIndex]);
  await write(session, second);
  await write(session, first);
  assert.equal(session.phase, 'complete');
  assert.ok(session.cards.every(card => card.complete));
  for (const card of [first, second, third, outside]) {
    assert.ok(
      card.calls.every(([kind]) =>
        ['authenticate', 'create', 'set', 'import'].includes(kind),
      ),
      'Normal writes must not repeat List, Get, View or Key fingerprint reads',
    );
  }
  assert.ok(
    session.cards.every(card =>
      card.items.every(
        item =>
          !('data' in item) &&
          !('exported' in item) &&
          !('fingerprint' in item),
      ),
    ),
  );
});

test('lost create response is reconciled from the card and never blindly replayed', async () => {
  const session = new CardSyncSession();
  const first = mockCard(1, false, [plain()]);
  const target = mockCard(2, false);
  await add(session, first);
  await add(session, target);
  session.prepare();
  target.afterMutation = () => {
    target.afterMutation = undefined;
    throw new Error('TAG_LOST');
  };
  await assert.rejects(write(session, target), /TAG_LOST/);
  assert.equal(session.cards[1].completed, 0);
  assert.equal(session.cards[1].complete, false);
  await write(session, target);
  assert.equal(mutationCalls(target).length, 1);
  assert.equal(session.phase, 'complete');
  assert.equal(session.confirmedSnapshot.items[0].index, publicIndex);
});

test('an uncertain operation which did not commit can continue after its old value is reread', async () => {
  const session = new CardSyncSession();
  const first = mockCard(1, false, [plain()]);
  const target = mockCard(2, false, [plain({data: 'bb'})]);
  await add(session, first);
  await add(session, target);
  session.prepare();
  target.beforeMutation = () => {
    target.beforeMutation = undefined;
    throw new Error('TAG_LOST');
  };
  await assert.rejects(write(session, target), /TAG_LOST/);
  await write(session, target);
  assert.equal(target.records.get(publicIndex).data, 'aa');
  assert.equal(mutationCalls(target).length, 2);
});

test('uncertain-result reconciliation reads only its item, not unrelated resources', async () => {
  const session = new CardSyncSession();
  const first = mockCard(1, 1, [root(), plain()]);
  const target = mockCard(2, 1, [root()]);
  await add(session, first);
  await add(session, target);
  session.prepare();
  target.afterMutation = () => {
    target.afterMutation = undefined;
    throw new Error('TAG_LOST');
  };
  await assert.rejects(write(session, target), /TAG_LOST/);
  target.calls.length = 0;
  await write(session, target);
  assert.deepEqual(target.calls, [
    ['authenticate', {secret: true, pin: PIN}],
    ['view', publicIndex],
    ['get', publicIndex],
  ]);
  assert.equal(session.cards[1].completed, 1);
  assert.equal(session.phase, 'complete');
});

for (const kind of ['create', 'data', 'alias']) {
  for (const committed of [false, true]) {
    test(`${kind} with ${committed ? 'lost ACK' : 'no commit'} resumes from only that item's result`, async () => {
      const session = new CardSyncSession();
      const source = plain({alias: 'Named'});
      const initial =
        kind === 'create'
          ? []
          : [plain(kind === 'data' ? {alias: 'Named', data: 'bb'} : {})];
      const first = mockCard(1, false, [source]);
      const target = mockCard(2, false, initial);
      await add(session, first);
      await add(session, target);
      session.prepare();
      const hook = committed ? 'afterMutation' : 'beforeMutation';
      target[hook] = () => {
        target[hook] = undefined;
        throw new Error('TAG_LOST');
      };
      await assert.rejects(write(session, target), /TAG_LOST/);
      assert.equal(session.cards[1].completed, 0);
      target.calls.length = 0;
      await write(session, target);
      assert.equal(target.records.get(publicIndex).alias, 'Named');
      assert.equal(target.records.get(publicIndex).data, 'aa');
      assert.equal(session.phase, 'complete');
      assert.equal(mutationCalls(target).length, committed ? 0 : 1);
      assert.deepEqual(
        target.calls.filter(([call]) => call === 'view'),
        [['view', publicIndex]],
      );
      assert.ok(
        target.calls.every(([call, index]) =>
          call === 'authenticate' ? true : index === publicIndex,
        ),
      );
    });
  }
}

test('ACKs survive cancellation and publish the confirmed metadata before later work', async () => {
  const session = new CardSyncSession();
  const first = mockCard(1, false, [plain(), plain({index: unknownIndex})]);
  const target = mockCard(2, false);
  await add(session, first);
  await add(session, target);
  session.prepare();
  const abort = new AbortController();
  target.afterMutation = () => {
    target.afterMutation = undefined;
    abort.abort();
  };
  await assert.rejects(
    session.write(target, target.hello, abort.signal, PIN),
    error => error.code === 'CANCELLED',
  );
  assert.equal(session.cards[1].completed, 1);
  assert.equal(session.confirmedSnapshot.items.length, 1);
  target.calls.length = 0;
  await write(session, target);
  assert.deepEqual(target.calls, [
    ['authenticate', {secret: true, pin: PIN}],
    ['create', unknownIndex],
  ]);
  assert.equal(session.phase, 'complete');
});

test('a final ACK completes the card even when cancellation arrives at the same time', async () => {
  const session = new CardSyncSession();
  const first = mockCard(1, false, [plain()]);
  const target = mockCard(2, false);
  await add(session, first);
  await add(session, target);
  session.prepare();
  target.calls.length = 0;
  const abort = new AbortController();
  target.afterMutation = () => abort.abort();
  await session.write(target, target.hello, abort.signal, PIN);
  assert.equal(session.phase, 'complete');
  assert.equal(session.cards[1].completed, 1);
  assert.equal(session.cards[1].complete, true);
  assert.equal(session.confirmedSnapshot.items[0].index, publicIndex);
  assert.deepEqual(target.calls, [
    ['authenticate', {secret: true, pin: PIN}],
    ['create', publicIndex],
  ]);
});

for (const opaque of [false, true]) {
  for (const committed of [false, true]) {
    test(`${opaque ? 'opaque Secret' : 'Key'} import with ${committed ? 'lost ACK' : 'no commit'} resumes idempotently without reading`, async () => {
      const session = new CardSyncSession();
      const item = root(opaque ? {index: unknownIndex, type: 0x1000} : {});
      const first = mockCard(1, 1, [item]);
      const target = mockCard(2, 1);
      await add(session, first, PIN);
      await add(session, target, PIN);
      session.prepare();
      const hook = committed ? 'afterMutation' : 'beforeMutation';
      target[hook] = () => {
        target[hook] = undefined;
        throw new Error('TAG_LOST');
      };
      await assert.rejects(write(session, target, PIN), /TAG_LOST/);
      assert.equal(session.cards[1].completed, 0);
      target.calls.length = 0;
      await write(session, target, PIN);
      assert.deepEqual(target.calls, [
        ['authenticate', {secret: true, pin: PIN}],
        ['import', item.index],
      ]);
      assert.deepEqual(target.records.get(item.index), item);
      assert.equal(session.phase, 'complete');
    });
  }
}

test('identical opaque Secret copies require non-self verification and can sync repeatedly', async () => {
  const session = new CardSyncSession();
  const secret = root({index: unknownIndex, type: 0x1000});
  const first = mockCard(1, 1, [secret]);
  const second = mockCard(2, 1, [secret]);
  await add(session, first, PIN);
  await add(session, second, PIN);
  assert.equal(session.noSyncRequired, false);
  session.prepare();
  assert.equal(session.phase, 'write');
  assert.deepEqual(
    session.cards.map(card => card.total),
    [1, 1],
  );
  await write(session, second, PIN);
  await write(session, first, PIN);
  assert.equal(session.phase, 'complete');
  assert.deepEqual(first.records.get(unknownIndex), secret);
  assert.deepEqual(second.records.get(unknownIndex), secret);
  session.reset();
  await add(session, first, PIN);
  await add(session, second, PIN);
  session.prepare();
  await write(session, first, PIN);
  await write(session, second, PIN);
  assert.equal(session.phase, 'complete');
});

test('opaque Secret body conflicts stop verification without replacing either copy', async () => {
  const session = new CardSyncSession();
  const first = mockCard(1, 1, [
    plain(),
    root({index: unknownIndex, type: 0x1000}),
  ]);
  const second = mockCard(2, 1, [
    plain({data: 'bb'}),
    root({index: unknownIndex, type: 0x1000, data: '99'}),
  ]);
  await add(session, first, PIN);
  await add(session, second, PIN);
  session.prepare();
  await assert.rejects(write(session, second, PIN), /conflicting Secret data/);
  assert.equal(session.cards[1].completed, 0);
  assert.equal(second.records.get(unknownIndex).data, '99');
  assert.equal(first.records.get(unknownIndex).data, '12');
  assert.equal(second.records.get(publicIndex).data, 'bb');
  assert.deepEqual(
    mutationCalls(second).map(([kind]) => kind),
    ['import'],
    'Secret verification must finish before unrelated plaintext writes',
  );
});

test('card identity and bundle are still checked before authentication or writes', async () => {
  const session = new CardSyncSession();
  const first = mockCard(1, 1, [root(), plain()]);
  const target = mockCard(2, 1, [root()]);
  await add(session, first, PIN);
  await add(session, target, PIN);
  session.prepare();
  target.calls.length = 0;
  const originalId = target.hello.id;
  target.hello.id = bytes('11111111');
  await assert.rejects(write(session, target), /Card changed/);
  assert.deepEqual(target.calls, []);
  target.hello.id = originalId;
  target.hello.bundle = new Uint8Array(32).fill(2);
  await assert.rejects(write(session, target), /Card changed/);
  assert.deepEqual(target.calls, []);
});

test('seed chain code participates in equality and oversized merged data fails before write', async () => {
  const session = new CardSyncSession();
  const seed = {
    index: '02200000000000000001',
    type: 'seed',
    secret: true,
    data: '12',
  };
  const first = mockCard(1, 1, [seed]);
  const second = mockCard(2, 1, [{...seed, chainCode: '22'.repeat(32)}]);
  await add(session, first, PIN);
  await add(session, second, PIN);
  assert.equal(session.noSyncRequired, false);
  assert.throws(() => session.prepare(), /conflicting Secret data/);
  session.reset();
  const large = mockCard(1, false, [plain({data: 'aa'.repeat(8200)})]);
  const empty = mockCard(2, false);
  await add(session, large);
  await add(session, empty);
  assert.throws(() => session.prepare(), /card limits/);
  assert.equal(mutationCalls(empty).length, 0);
});
