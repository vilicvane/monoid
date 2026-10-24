import assert from 'node:assert/strict';
import {test} from 'node:test';

import {CardSyncSession} from '../.bld/app/@components/views/safe/@card/card-sync-session.js';
import {
  decodeCardDerivationRecord,
  encodeCardDerivationRecord,
  getCardDerivationItemIndex,
} from '../.bld/app/@components/views/safe/card-derivations.js';
import {AppletISOError} from '../.bld/app/@lib/applet.js';
import {CBORAppletError} from '../.bld/app/@lib/cbor-applet.js';
import {credential} from './helpers/security-key-credential.mjs';

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
      authority: false,
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
          ({index, type, alias, metadata, secret}) => ({
            index: bytes(index),
            type,
            alias,
            metadata: metadata === undefined ? undefined : bytes(metadata),
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
        metadata:
          item.metadata === undefined ? undefined : bytes(item.metadata),
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
        metadata:
          item.metadata === undefined ? undefined : bytes(item.metadata),
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
        request.metadata === undefined ? undefined : hex(request.metadata),
        incoming.metadata,
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
        metadata:
          request.metadata === undefined ? undefined : hex(request.metadata),
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

test('OTP sync keeps account metadata inside the bundle and resumes its interrupted create after the secret', async () => {
  const hmac = {
    index: '05140000000000000001',
    type: 'hmac',
    secret: true,
    data: '1234',
  };
  const account = {
    index: 'f2010000000000000001',
    type: 0xf201,
    secret: false,
    metadata: '010106001e',
    data: hmac.index,
    alias: 'Example',
  };
  const source = mockCard(1, 1, [account, hmac]);
  const target = mockCard(2, 1);
  const unrelated = mockCard(3, 2);
  const session = new CardSyncSession();
  await add(session, source);
  await add(session, target);
  await add(session, unrelated);
  assert.equal(
    source.calls.some(([kind]) => kind === 'viewKey'),
    false,
  );
  session.prepare();
  let interrupted = false;
  target.afterMutation = async kind => {
    if (kind === 'create' && !interrupted) {
      interrupted = true;
      throw new Error('Lost response');
    }
  };
  await assert.rejects(write(session, target), /Lost response/);
  assert.deepEqual(
    mutationCalls(target).map(([kind, index]) => [kind, index]),
    [
      ['import', hmac.index],
      ['create', account.index],
    ],
  );
  await write(session, target);
  assert.equal(
    mutationCalls(target).length,
    2,
    'do not replay acknowledged account creation',
  );
  assert.equal(target.records.get(account.index).data, hmac.index);
  assert.equal(
    session.cards
      .find(card => card.publicKey === hex(target.hello.publicKey))
      .items.find(item => item.index === account.index).otpKeyIndex,
    hmac.index,
  );
  assert.equal(
    session.cards.find(
      card => card.publicKey === hex(unrelated.hello.publicKey),
    ).items.length,
    0,
  );
});

test('public credential scopes coexist across Bundles without grant or Seed migration', async () => {
  const firstCredential = credential(1);
  const secondCredential = credential(2, {scope: 2});
  const first = mockCard(1, 1, [root(), firstCredential]);
  const second = mockCard(2, 2, [root({data: '34'}), secondCredential]);
  const third = mockCard(3, false);
  const session = new CardSyncSession();
  for (const card of [first, second, third]) await add(session, card);
  session.prepare();
  for (const card of [first, second, third]) await write(session, card);
  assert.equal(session.phase, 'complete');
  for (const card of [first, second, third]) {
    for (const item of [firstCredential, secondCredential]) {
      assert.equal(card.records.get(item.index).data, item.data);
      assert.equal(card.records.get(item.index).metadata, item.metadata);
    }
    assert.ok(
      mutationCalls(card).every(
        ([kind, index]) => kind === 'create' && index.startsWith('f101'),
      ),
    );
  }
  assert.equal(first.records.get(keyIndex).data, '12');
  assert.equal(second.records.get(keyIndex).data, '34');
  assert.equal(third.records.has(keyIndex), false);
});

test('Sync skips incompatible credentials and retains independent items', async () => {
  for (const item of [
    credential(1, {fields: [[10, undefined]]}),
    credential(1, {fields: [[10, new Uint8Array(31)]]}),
    credential(1, {metadata: '00'.repeat(64)}),
    credential(1, {secret: true}),
  ]) {
    const session = new CardSyncSession();
    const card = mockCard(1, 1, [plain(), item]);
    await add(session, card);
    assert.deepEqual(
      session.cards[0].items.map(item => item.index),
      [publicIndex],
    );
    assert.deepEqual(session.cards[0].skippedIndexes, [item.index]);
    assert.deepEqual(
      session.confirmedSnapshot.items.map(item => item.index),
      [publicIndex],
    );
    assert.deepEqual(mutationCalls(card), []);
    if (item.secret)
      assert.equal(
        card.calls.some(
          ([name, index]) => name === 'get' && index === item.index,
        ),
        false,
      );
    assert.equal(
      card.calls.some(([name]) => name === 'export'),
      false,
    );
  }
});

test('Sync leaves an incompatible destination record intact while completing other items', async () => {
  const valid = credential(1);
  const incompatible = credential(1, {fields: [[1, 2]]});
  const source = mockCard(1, 1, [valid, plain()]);
  const target = mockCard(2, 1, [incompatible]);
  const session = new CardSyncSession();
  await add(session, source);
  await add(session, target);
  session.prepare();
  await write(session, target);
  assert.equal(session.phase, 'complete');
  assert.deepEqual(target.records.get(valid.index), incompatible);
  assert.equal(target.records.get(publicIndex).data, 'aa');
  assert.deepEqual(mutationCalls(target), [['create', publicIndex]]);
});

test('incompatible record filtering does not swallow transport failures', async () => {
  const record = credential(1);
  const card = mockCard(1, 1, [record, plain()]);
  const failure = new Error('Card disconnected');
  card.get = async () => {
    throw failure;
  };
  const session = new CardSyncSession();
  await assert.rejects(add(session, card), error => error === failure);
  assert.equal(session.cards.length, 0);
});

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
    metadata: keyIndex,
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

// Header fields model Bundle envelopes; the fixture payload remains readable
// JSON so a restore can prove whose complete item was actually re-exported.
function recoveryCard(id, bundle, entries = []) {
  const card = mockCard(id, bundle, entries);
  const exportItem = card.exportItem;
  const importItem = card.importItem;
  card.exportItem = async request => {
    const result = await exportItem(request);
    const data = new Uint8Array(160 + result.data.length);
    data[0] = 2;
    data.set(card.hello.bundle, 1);
    data.set(card.hello.publicKey, 33);
    data.set(result.data, 160);
    return {...result, data};
  };
  card.importItem = request =>
    importItem({...request, data: request.data.subarray(160)});
  return card;
}

const identity = card => ({
  id: hex(card.hello.id),
  publicKey: hex(card.hello.publicKey),
  bundle: card.hello.bundle === false ? false : hex(card.hello.bundle),
});

test('recovery freshly exports merged peer contents, including the target-only Secret, without writing the target', async () => {
  const session = new CardSyncSession();
  const commonIndex = '03010000000000000002';
  const companion = addressType => ({
    index: getCardDerivationItemIndex(commonIndex),
    type: 0x0f01,
    metadata: commonIndex,
    secret: false,
    data: hex(
      encodeCardDerivationRecord({
        index: commonIndex,
        wallets: [{addressType}],
      }),
    ),
  });
  const first = recoveryCard(1, 1, [
    root({alias: 'Only on target'}),
    root({index: commonIndex, alias: 'First'}),
    companion('evm'),
  ]);
  const peer = recoveryCard(2, 1, [
    root({index: commonIndex, alias: 'Second'}),
    companion('bitcoin-taproot'),
    plain(),
  ]);
  await add(session, first);
  await add(session, peer);
  session.prepare();
  await write(session, peer);
  assert.equal(session.cards[1].complete, true);
  assert.equal(session.cards[0].complete, false);
  assert.deepEqual(mutationCalls(first), []);
  assert.equal(first.records.has(publicIndex), false);
  assert.equal(peer.records.get(commonIndex).alias, 'First');
  const cached = session.cards[1].items.find(item => item.index === keyIndex);
  assert.equal(
    hex(bytes(cached.exported.data).subarray(33, 98)),
    identity(first).publicKey,
  );
  peer.calls.length = 0;
  const progress = [];

  const recovery = await session.exportRecovery(
    peer,
    peer.hello,
    identity(first),
    signal(),
    update => progress.push(update),
  );

  assert.deepEqual(recovery.source, identity(peer));
  assert.equal(recovery.items.length, peer.records.size);
  assert.ok(peer.calls.every(([kind]) => kind === 'export'));
  assert.equal(peer.calls.length, peer.records.size);
  assert.deepEqual(
    progress.map(({current}) => current),
    [0, 1, 2, 3, 4],
  );
  assert.ok(
    progress.every(({stage, total}) => stage === 'exporting' && total === 4),
  );
  for (const item of recovery.items) {
    assert.equal(
      hex(bytes(item.data).subarray(33, 98)),
      identity(peer).publicKey,
    );
    assert.equal('fingerprint' in item, false);
    assert.equal('derivationRecord' in item, false);
  }
  const restored = recoveryCard(1, 1);
  for (const item of recovery.items) {
    await restored.importItem({
      index: bytes(item.index),
      metadata: item.key === undefined ? undefined : bytes(item.key),
      alias: item.alias,
      data: bytes(item.data),
    });
  }
  assert.deepEqual(
    [...restored.records].sort(([a], [b]) => a.localeCompare(b)),
    [...peer.records].sort(([a], [b]) => a.localeCompare(b)),
  );
  assert.equal(session.cards[0].complete, false);
  assert.deepEqual(mutationCalls(first), []);
});

test('three-card recovery merges every Secret and derivation before exporting the last peer without writing the target', async () => {
  const session = new CardSyncSession();
  const seedIndex = '02400000000000000001';
  const recordIndex = getCardDerivationItemIndex(seedIndex);
  const wallets = [0, 1, 2].map(account => ({
    addressType: 'evm',
    seed: 'Bitcoin seed',
    curve: 'secp256k1',
    path: `m/44'/60'/0'/0/${account}`,
  }));
  const uniqueSecrets = [1, 2, 3].map(id =>
    root({
      index: `0301000000000000000${id}`,
      data: `${id}${id}`,
      alias: `Secret ${id}`,
    }),
  );
  const uniquePublic = [1, 2, 3].map(id =>
    plain({index: `1000000000000000000${id}`, data: `${id}a`}),
  );
  const seed = root({index: seedIndex, type: 'seed', data: '64'});
  const record = entries => ({
    index: recordIndex,
    type: 0x0f01,
    metadata: seedIndex,
    secret: false,
    data: hex(encodeCardDerivationRecord({index: seedIndex, wallets: entries})),
  });
  const cards = [1, 2, 3].map((id, index) =>
    recoveryCard(id, 1, [
      uniqueSecrets[index],
      uniquePublic[index],
      {...seed, alias: ['', 'Shared seed', 'Later name'][index]},
      record(index === 0 ? [wallets[0]] : [wallets[index], wallets[0]]),
    ]),
  );
  const [target, second, third] = cards;
  const originalTarget = structuredClone([...target.records]);
  for (const card of cards) await add(session, card);
  session.prepare();
  for (const card of cards) card.calls.length = 0;

  await write(session, third);
  assert.deepEqual(
    session.cards.map(card => card.complete),
    [false, false, true],
  );
  await write(session, second);
  assert.deepEqual(
    session.cards.map(card => card.complete),
    [false, true, true],
  );
  assert.equal(session.phase, 'write');
  assert.ok(
    cards.every(card => !card.calls.some(([kind]) => kind === 'export')),
  );

  const expected = [
    ...uniqueSecrets,
    ...uniquePublic,
    {...seed, alias: 'Shared seed'},
    record(wallets),
  ];
  const contents = entries =>
    [...entries]
      .map(({index, secret, metadata, alias, data}) => ({
        index,
        secret,
        metadata,
        alias,
        data,
      }))
      .sort((left, right) => left.index.localeCompare(right.index));
  for (const peer of [second, third]) {
    assert.deepEqual(contents(peer.records.values()), contents(expected));
    assert.deepEqual(
      decodeCardDerivationRecord(bytes(peer.records.get(recordIndex).data))
        .wallets,
      wallets,
    );
  }
  const beforeExport = second.calls.length;
  const recovery = await session.exportRecovery(
    second,
    second.hello,
    identity(target),
    signal(),
  );
  assert.deepEqual(recovery.source, identity(second));
  assert.equal(recovery.items.length, expected.length);
  assert.equal(second.calls.length - beforeExport, expected.length);
  assert.ok(
    second.calls.slice(beforeExport).every(([kind]) => kind === 'export'),
  );
  assert.ok(third.calls.every(([kind]) => kind !== 'export'));
  for (const item of recovery.items) {
    assert.equal(
      hex(bytes(item.data).subarray(33, 98)),
      identity(second).publicKey,
    );
  }

  const restored = recoveryCard(1, 1);
  for (const item of recovery.items) {
    await restored.importItem({
      index: bytes(item.index),
      metadata: item.key === undefined ? undefined : bytes(item.key),
      alias: item.alias,
      data: bytes(item.data),
    });
  }
  assert.deepEqual(contents(restored.records.values()), contents(expected));
  assert.deepEqual([...target.records], originalTarget);
  assert.deepEqual(mutationCalls(target), []);
});

test('the last of multiple peers can export recovery after completion releases every cached payload', async () => {
  const session = new CardSyncSession();
  const entries = [
    root({metadata: '', alias: ''}),
    root({index: '03010000000000000002', data: '34'}),
    plain(),
  ];
  const target = recoveryCard(1, 1, entries);
  const second = recoveryCard(2, 1, entries.slice(0, 1));
  const third = recoveryCard(3, 1, entries.slice(1));
  for (const card of [target, second, third]) await add(session, card);
  session.prepare();
  assert.deepEqual(
    session.cards.map(card => card.complete),
    [true, false, false],
  );
  await write(session, third);
  assert.equal(session.phase, 'write');
  await write(session, second);
  assert.equal(session.phase, 'complete');
  assert.ok(
    session.cards.every(card =>
      card.items.every(
        item =>
          !('data' in item) &&
          !('fingerprint' in item) &&
          !('exported' in item),
      ),
    ),
  );
  second.calls.length = 0;
  const recovery = await session.exportRecovery(
    second,
    second.hello,
    identity(target),
    signal(),
  );
  assert.deepEqual(recovery.source, identity(second));
  assert.deepEqual(
    second.calls.map(([kind, index]) => [kind, index]),
    entries.map(item => ['export', item.index]),
  );
  const restored = recoveryCard(1, 1);
  for (const item of recovery.items) {
    await restored.importItem({
      index: bytes(item.index),
      metadata: item.key === undefined ? undefined : bytes(item.key),
      alias: item.alias,
      data: bytes(item.data),
    });
  }
  assert.deepEqual([...restored.records], [...target.records]);
  assert.deepEqual(mutationCalls(target), []);
});

test('an unchanged peer still exports a complete recovery after sync payloads are released', async () => {
  const session = new CardSyncSession();
  const entries = [root({metadata: '', alias: ''}), plain()];
  const first = recoveryCard(1, 1, entries);
  const peer = recoveryCard(2, 1, entries);
  await add(session, first);
  await add(session, peer);
  assert.equal(session.noSyncRequired, true);
  session.prepare();
  assert.equal(session.phase, 'complete');
  assert.ok(session.cards[1].items.every(item => item.exported === undefined));
  peer.calls.length = 0;
  await write(session, peer);
  assert.deepEqual(peer.calls, []);
  const recovery = await session.exportRecovery(
    peer,
    peer.hello,
    identity(first),
    signal(),
  );
  assert.deepEqual(peer.calls, [
    ['export', keyIndex],
    ['export', publicIndex],
  ]);
  assert.equal(recovery.items[0].key, '');
  assert.equal(recovery.items[0].alias, '');
  assert.equal(recovery.items[1].key, undefined);
  assert.equal(recovery.items[1].alias, undefined);
});

test('recovery refuses an unfinished peer before issuing any export', async () => {
  const session = new CardSyncSession();
  const first = recoveryCard(1, 1, [root()]);
  const peer = recoveryCard(2, 1);
  await add(session, first);
  await add(session, peer);
  session.prepare();
  peer.calls.length = 0;
  await assert.rejects(
    session.exportRecovery(peer, peer.hello, identity(first), signal()),
    /Sync the card first/,
  );
  assert.deepEqual(peer.calls, []);
});

test('recovery refuses a partial snapshot even though ordinary sync skipped unsupported records', async () => {
  const session = new CardSyncSession();
  const first = recoveryCard(1, 1, [
    plain(),
    credential(1, {fields: [[1, 2]]}),
  ]);
  const peer = recoveryCard(2, 1, [plain()]);
  await add(session, first);
  await add(session, peer);
  session.prepare();
  assert.equal(session.phase, 'complete');
  peer.calls.length = 0;
  await assert.rejects(
    session.exportRecovery(peer, peer.hello, identity(first), signal()),
    /Cannot back up unsupported items/,
  );
  assert.deepEqual(peer.calls, []);
});

for (const changedIdentity of [
  'self',
  'unknown peer',
  'peer ID',
  'peer bundle',
  'target ID',
  'target bundle',
]) {
  test(`recovery rejects ${changedIdentity} before exporting`, async () => {
    const session = new CardSyncSession();
    const first = recoveryCard(1, 1, [plain()]);
    const peer = recoveryCard(2, 1, [plain()]);
    await add(session, first);
    await add(session, peer);
    session.prepare();
    const target = identity(first);
    const hello = structuredClone(peer.hello);
    if (changedIdentity === 'self') Object.assign(target, identity(peer));
    if (changedIdentity === 'unknown peer')
      hello.publicKey = recoveryCard(3, 1).hello.publicKey;
    if (changedIdentity === 'peer ID') hello.id = bytes('12345678');
    if (changedIdentity === 'peer bundle')
      hello.bundle = new Uint8Array(32).fill(2);
    if (changedIdentity === 'target ID') target.id = '12345678';
    if (changedIdentity === 'target bundle') target.bundle = '02'.repeat(32);
    peer.calls.length = 0;
    await assert.rejects(
      session.exportRecovery(peer, hello, target, signal()),
      /same bundle|Card changed|card in this sync/,
    );
    assert.deepEqual(peer.calls, []);
  });
}

for (const peerBundle of [false, 2]) {
  test(`recovery rejects a collected peer in ${peerBundle === false ? 'no' : 'another'} Bundle`, async () => {
    const session = new CardSyncSession();
    const first = recoveryCard(1, 1, [plain()]);
    const peer = recoveryCard(2, peerBundle, [plain()]);
    await add(session, first);
    await add(session, peer);
    session.prepare();
    peer.calls.length = 0;
    await assert.rejects(
      session.exportRecovery(peer, peer.hello, identity(first), signal()),
      /same bundle/,
    );
    assert.deepEqual(peer.calls, []);
  });
}

for (const field of ['alias', 'metadata']) {
  test(`recovery rejects changed ${field} without accepting the exported item`, async () => {
    const session = new CardSyncSession();
    const first = recoveryCard(1, 1, [plain()]);
    const peer = recoveryCard(2, 1, [plain()]);
    await add(session, first);
    await add(session, peer);
    session.prepare();
    // Missing and explicitly empty authenticated metadata must stay distinct.
    peer.records.get(publicIndex)[field] = '';
    const progress = [];
    await assert.rejects(
      session.exportRecovery(
        peer,
        peer.hello,
        identity(first),
        signal(),
        update => progress.push(update),
      ),
      /Card changed/,
    );
    assert.deepEqual(
      progress.map(({current}) => current),
      [0],
    );
    assert.equal(session.cards[1].complete, true);
  });
}

for (const invalid of [
  'version',
  'truncated',
  'bundle',
  'sender',
  'oversized',
]) {
  test(`recovery rejects an invalid ${invalid} envelope`, async () => {
    const session = new CardSyncSession();
    const first = recoveryCard(1, 1, [plain()]);
    const peer = recoveryCard(2, 1, [plain()]);
    await add(session, first);
    await add(session, peer);
    session.prepare();
    const exportItem = peer.exportItem;
    peer.exportItem = async request => {
      const exported = await exportItem(request);
      if (invalid === 'version') exported.data[0] = 1;
      if (invalid === 'truncated')
        exported.data = exported.data.subarray(0, 159);
      if (invalid === 'bundle') exported.data[1] ^= 1;
      if (invalid === 'sender') exported.data.set(first.hello.publicKey, 33);
      if (invalid === 'oversized') {
        const data = new Uint8Array(8192);
        data.set(exported.data);
        exported.data = data;
      }
      return exported;
    };
    const progress = [];
    await assert.rejects(
      session.exportRecovery(
        peer,
        peer.hello,
        identity(first),
        signal(),
        update => progress.push(update),
      ),
    );
    assert.deepEqual(
      progress.map(({current}) => current),
      [0],
    );
    assert.equal(session.busy, false);
  });
}

test('interrupted recovery export retains peer write ACKs and only returns a complete archive on explicit retry', async () => {
  const session = new CardSyncSession();
  const first = recoveryCard(1, 1, [root(), plain()]);
  const peer = recoveryCard(2, 1);
  await add(session, first);
  await add(session, peer);
  session.prepare();
  await write(session, peer);
  const exportItem = peer.exportItem;
  const failure = new Error('Export interrupted');
  peer.exportItem = request => {
    if (hex(request.index) === publicIndex) throw failure;
    return exportItem(request);
  };
  const progress = [];
  await assert.rejects(
    session.exportRecovery(
      peer,
      peer.hello,
      identity(first),
      signal(),
      update => progress.push(update),
    ),
    error => error === failure,
  );
  assert.deepEqual(
    progress.map(({current}) => current),
    [0, 1],
  );
  assert.equal(session.cards[1].complete, true);
  assert.equal(session.cards[1].completed, 2);
  assert.equal(session.busy, false);
  assert.deepEqual(mutationCalls(first), []);
  const mutations = mutationCalls(peer).length;
  peer.exportItem = exportItem;
  const recovery = await session.exportRecovery(
    peer,
    peer.hello,
    identity(first),
    signal(),
  );
  assert.equal(recovery.items.length, 2);
  assert.equal(mutationCalls(peer).length, mutations);
});

test('cancellation after a recovery export ACK counts that item but returns no partial archive', async () => {
  const session = new CardSyncSession();
  const entries = [root(), plain()];
  const first = recoveryCard(1, 1, entries);
  const peer = recoveryCard(2, 1, entries);
  await add(session, first);
  await add(session, peer);
  session.prepare();
  const exportItem = peer.exportItem;
  const abort = new AbortController();
  peer.calls.length = 0;
  peer.exportItem = async request => {
    const result = await exportItem(request);
    abort.abort();
    return result;
  };
  const progress = [];
  await assert.rejects(
    session.exportRecovery(
      peer,
      peer.hello,
      identity(first),
      abort.signal,
      update => progress.push(update),
    ),
    error => error.code === 'CANCELLED',
  );
  assert.deepEqual(
    progress.map(({current}) => current),
    [0, 1],
  );
  assert.deepEqual(peer.calls, [['export', keyIndex]]);
  assert.equal(session.cards[1].complete, true);
  assert.equal(session.busy, false);
});
