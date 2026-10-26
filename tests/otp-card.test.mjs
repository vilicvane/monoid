import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

import {p256} from '@noble/curves/nist';
import {sha256, toUtf8Bytes} from 'ethers';

import {
  CardItemExistsError,
  CardItemNotFoundError,
} from '../.bld/app/@lib/cbor-applet.js';

let otp;
const OTP_AID = Uint8Array.from(Buffer.from('f06d6f6e6f69640501', 'hex'));
mock.module('../.bld/app/@lib/otp-applet.js', {
  namedExports: {
    OTP_AID,
    createOTPApplet: () => ({attachSession: () => otp}),
  },
});
const {AppletISOError, AppletNotFoundError} = await import(
  '../.bld/app/@lib/applet.js'
);
const {
  addOTPAccount,
  authorizeOTPAccounts,
  isOTPInstalled,
  readOTPAccounts,
  readOTPCard,
  removeOTPAccount,
} = await import('../.bld/app/@lib/otp-card.js');

const bytes = value => Uint8Array.from(Buffer.from(value, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const signal = () => new AbortController().signal;
const configuration = {algorithm: 'SHA1', digits: 6, period: 30};
const secret = toUtf8Bytes('12345678901234567890');
const hmacIndex = bytes(`0514${sha256(secret).slice(2, 18)}`);
const accountIndex = bytes(`f201${sha256(secret).slice(2, 18)}`);
const secondIndex = bytes('f2011112131415161718');
const hello = {
  id: bytes('11223344'),
  publicKey: p256.getPublicKey(1n, false),
  version: 0,
  bundle: false,
  authority: false,
  pins: {access: 5, secret: 5},
};

function accountRecord(index = accountIndex, overrides = {}) {
  return {
    index,
    metadata: new Uint8Array([1, 1, 6, 0, 30]),
    alias: 'Example: alice',
    secret: true,
    data: secret,
    ...overrides,
  };
}
function grant(overrides = {}) {
  return {
    aid: OTP_AID,
    tokenHash: new Uint8Array(32),
    types: [[-3583, false]],
    ...overrides,
  };
}

function card(options = {}) {
  const commands = [];
  const items = new Map(
    (options.items ?? []).map(item => [hex(item.index), {...item}]),
  );
  let grants = options.grants ?? [];
  otp = {
    async select() {
      if (options.notInstalled) throw new AppletNotFoundError(new Uint8Array());
    },
    async hello() {
      commands.push(['otp.hello']);
      if (options.helloError) throw options.helloError;
      return {version: new Uint8Array([0, 0]), batchSize: 3};
    },
    async challenge() {
      commands.push(['otp.challenge']);
      if (options.challengeError) throw options.challengeError;
      return {challenge: new Uint8Array(32)};
    },
  };
  const applet = {
    async view({index}) {
      commands.push(['view', hex(index)]);
      const item = items.get(hex(index));
      if (!item) throw new CardItemNotFoundError({code: 'NOT_FOUND'});
      const {data: _data, ...metadata} = item;
      return metadata;
    },
    async list(request) {
      commands.push(['list', request]);
      await options.onList?.();
      return {
        items: [...items.values()]
          .filter(item =>
            request.type === 'hmac'
              ? item.index[0] === 5
              : request.type === -3583
                ? item.index[0] === 0xf2 && item.index[1] === 1
                : true,
          )
          .map(({data: _data, ...item}) => item),
      };
    },
    async get({index}) {
      commands.push(['get', hex(index)]);
      const item = items.get(hex(index));
      if (!item) throw new CardItemNotFoundError({code: 'NOT_FOUND'});
      if (item.secret) throw new Error('ACCESS_DENIED');
      return {data: item.data};
    },
    async listAppletGrants() {
      commands.push(['grants']);
      return {grants};
    },
    async setAppletGrant(request) {
      commands.push(['grant', request]);
      await options.onGrant?.(request);
      grants = [
        ...grants.filter(grant => hex(grant.aid) !== hex(request.aid)),
        {...request, tokenHash: new Uint8Array(32)},
      ];
      return {};
    },
    async create(request) {
      commands.push(['create', request]);
      assert.equal('type' in request, false);
      const index = request.index;
      assert.equal(hex(index), `f201${sha256(request.data).slice(2, 18)}`);
      assert.equal(request.secret, true);
      if (items.has(hex(index)))
        throw new CardItemExistsError({code: 'EXISTS'});
      items.set(hex(index), {...request, index});
      await options.onCreate?.(request, index);
      return {index};
    },
    async set(request) {
      commands.push(['set', request]);
      const item = items.get(hex(request.index));
      assert.ok(item);
      Object.assign(item, request);
      return {};
    },
    async remove({index}) {
      commands.push(['remove', hex(index)]);
      const removed = items.delete(hex(index));
      await options.onRemove?.(index);
      return {removed};
    },
  };
  return {applet, commands, items};
}

test('OTP preflight only probes Hello and distinguishes absence from failures', async () => {
  for (const notInstalled of [false, true]) {
    const {applet, commands} = card({notInstalled});
    assert.equal(await isOTPInstalled(applet, signal()), !notInstalled);
    assert.deepEqual(commands, notInstalled ? [] : [['otp.hello']]);
  }
  for (const helloError of [
    new AppletISOError('OTP Hello', 0x6982, new Uint8Array()),
    new Error('Connection lost'),
  ]) {
    const {applet, commands} = card({helloError});
    await assert.rejects(
      isOTPInstalled(applet, signal()),
      error => error === helloError,
    );
    assert.deepEqual(commands, [['otp.hello']]);
  }
  const {applet, commands} = card();
  await assert.rejects(isOTPInstalled(applet, AbortSignal.abort()), {
    name: 'AbortError',
  });
  assert.deepEqual(commands, []);
});

test('OTP list returns configuration and aliases in one list without reading secret data', async () => {
  const fixture = card({
    items: [accountRecord(), {index: hmacIndex, secret: true}],
  });
  const accounts = await readOTPAccounts(fixture.applet, signal());
  assert.deepEqual(accounts, [
    {index: hex(accountIndex), label: 'Example: alice', ...configuration},
  ]);
  assert.deepEqual(fixture.commands, [['list', {type: -3583}]]);
  assert.ok(!JSON.stringify(accounts).includes(hex(secret)));
});

test('OTP list skips incompatible items individually', async () => {
  for (const override of [
    {secret: false},
    {metadata: undefined},
    {metadata: new Uint8Array()},
    {metadata: bytes('020106001e')},
    {metadata: bytes('010406001e')},
    {metadata: bytes('010107001e')},
    {metadata: bytes('0101060000')},
    {metadata: bytes('0101068000')},
    {index: bytes('f20100')},
  ]) {
    const fixture = card({
      items: [
        accountRecord(accountIndex, override),
        accountRecord(secondIndex),
      ],
    });
    assert.deepEqual(
      (await readOTPAccounts(fixture.applet, signal())).map(item => item.index),
      [hex(secondIndex)],
    );
    assert.deepEqual(fixture.commands, [['list', {type: -3583}]]);
  }
});

test('OTP list propagates communication, permission and cancellation failures', async () => {
  for (const failure of [
    new Error('Tag lost'),
    new AppletISOError('Denied', 0x6982, new Uint8Array()),
  ]) {
    const fixture = card({
      onList() {
        throw failure;
      },
    });
    await assert.rejects(
      readOTPAccounts(fixture.applet, signal()),
      error => error === failure,
    );
  }
  const controller = new AbortController();
  const fixture = card({
    onList() {
      controller.abort();
    },
  });
  await assert.rejects(readOTPAccounts(fixture.applet, controller.signal), {
    name: 'AbortError',
  });
  const cancelled = card();
  await assert.rejects(readOTPAccounts(cancelled.applet, AbortSignal.abort()), {
    name: 'AbortError',
  });
  assert.deepEqual(cancelled.commands, []);
});

test('OTP authorization checks the exact type and installation token without HMAC key grants', async () => {
  const items = [accountRecord()];
  const valid = card({items, grants: [grant()]});
  assert.equal(
    (await readOTPCard(valid.applet, hello, signal())).authorized,
    true,
  );
  assert.deepEqual(
    valid.commands.map(([name]) => name),
    ['list', 'grants', 'otp.hello', 'otp.challenge'],
  );
  for (const types of [undefined, [[-3582, false]]]) {
    const fixture = card({
      items,
      grants: [grant({types, keys: [{index: hmacIndex, type: 'hmac'}]})],
    });
    assert.equal(
      (await readOTPCard(fixture.applet, hello, signal())).authorized,
      false,
    );
    assert.ok(!fixture.commands.some(([name]) => name === 'otp.challenge'));
  }
  const stale = card({
    items,
    grants: [grant()],
    challengeError: new AppletISOError('stale token', 0x6982, new Uint8Array()),
  });
  assert.equal(
    (await readOTPCard(stale.applet, hello, signal())).authorized,
    false,
  );
  const missing = card({items, grants: [grant()], notInstalled: true});
  assert.equal(
    (await readOTPCard(missing.applet, hello, signal())).authorized,
    false,
  );
  const interrupted = card({
    items,
    grants: [grant()],
    challengeError: new Error('Tag lost'),
  });
  await assert.rejects(
    readOTPCard(interrupted.applet, hello, signal()),
    /Tag lost/,
  );
});

test('Enable writes one type grant with no keys regardless of account count', async () => {
  for (const count of [0, 1, 17]) {
    const fixture = card({
      items: Array.from({length: count}, (_, i) =>
        accountRecord(bytes(`f201${i.toString(16).padStart(16, '0')}`)),
      ),
    });
    assert.equal(
      (await authorizeOTPAccounts(fixture.applet, signal())).length,
      count,
    );
    assert.deepEqual(fixture.commands, [
      ['list', {type: -3583}],
      ['grant', {aid: OTP_AID, types: [[-3583, false]]}],
    ]);
  }
});

test('adding an OTP account creates only the digest-indexed secret item and keeps grants unchanged', async () => {
  const fixture = card({items: [accountRecord(secondIndex)]});
  const accounts = await addOTPAccount(
    fixture.applet,
    {...configuration, secret, label: 'Example: alice'},
    signal(),
  );
  assert.deepEqual(
    fixture.commands.map(([name]) => name),
    ['list', 'create'],
  );
  assert.deepEqual(fixture.commands[1][1], {
    index: accountIndex,
    metadata: bytes('010106001e'),
    alias: 'Example: alice',
    data: secret,
    secret: true,
  });
  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts[1], {
    index: hex(accountIndex),
    label: 'Example: alice',
    ...configuration,
  });
  const current = await readOTPCard(fixture.applet, hello, signal(), accounts);
  assert.equal(current.authorized, false);
  assert.equal(fixture.commands.filter(([name]) => name === 'list').length, 1);
});

test('same-secret EXISTS compares only View configuration, label and protection', async () => {
  for (const override of [
    {},
    {alias: 'Other'},
    {metadata: bytes('010108001e')},
    {secret: false},
    {metadata: bytes('09')},
  ]) {
    const fixture = card({items: [accountRecord(accountIndex, override)]});
    const adding = addOTPAccount(
      fixture.applet,
      {...configuration, secret, label: 'Example: alice'},
      signal(),
    );
    if (Object.keys(override).length)
      await assert.rejects(adding, /conflicting item data/);
    else assert.equal((await adding).length, 1);
    assert.deepEqual(
      fixture.commands.map(([name]) => name),
      ['list', 'create', 'view'],
    );
    assert.deepEqual(
      fixture.items.get(hex(accountIndex)),
      accountRecord(accountIndex, override),
    );
  }
});

test('invalid secret lengths and configuration stop before NFC', async () => {
  for (const override of [
    {secret: new Uint8Array()},
    {secret: new Uint8Array(256)},
    {period: 0},
  ]) {
    const fixture = card();
    await assert.rejects(
      addOTPAccount(
        fixture.applet,
        {...configuration, secret, label: 'Example', ...override},
        signal(),
      ),
    );
    assert.deepEqual(fixture.commands, []);
  }
});

test('an uncertain or cancelled create is never replayed or reconciled automatically', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const fixture = card({
      onCreate() {
        if (cancel) controller.abort();
        else throw new Error('Tag lost');
      },
    });
    await assert.rejects(
      addOTPAccount(
        fixture.applet,
        {...configuration, secret, label: 'Example'},
        controller.signal,
      ),
      cancel ? {name: 'AbortError'} : /Tag lost/,
    );
    assert.deepEqual(
      fixture.commands.map(([name]) => name),
      ['list', 'create'],
    );
    assert.equal(fixture.items.size, 1);
  }
});

test('delete removes only F201, retains unrelated HMAC items and never rewrites grants', async () => {
  const fixture = card({
    items: [
      accountRecord(),
      accountRecord(secondIndex),
      {index: hmacIndex, secret: true},
    ],
    notInstalled: true,
  });
  const next = await removeOTPAccount(
    fixture.applet,
    {id: '01020304'},
    {index: hex(accountIndex), ...configuration},
    signal(),
  );
  assert.deepEqual(
    next.map(item => item.index),
    [hex(secondIndex)],
  );
  assert.deepEqual(fixture.commands, [
    ['list', {type: -3583}],
    ['remove', hex(accountIndex)],
  ]);
  assert.ok(fixture.items.has(hex(hmacIndex)));
});

test('delete skips a missing or incompatible account without writing', async () => {
  for (const items of [[], [accountRecord(accountIndex, {secret: false})]]) {
    const fixture = card({items});
    assert.equal(
      await removeOTPAccount(
        fixture.applet,
        {id: '01020304'},
        {index: hex(accountIndex), ...configuration},
        signal(),
      ),
      undefined,
    );
    assert.deepEqual(fixture.commands, [['list', {type: -3583}]]);
  }
});

test('delete checks changed configuration and never replays uncertain or cancelled removal', async () => {
  const account = {index: hex(accountIndex), ...configuration};
  const changed = card({
    items: [accountRecord(accountIndex, {metadata: bytes('010108001e')})],
  });
  await assert.rejects(
    removeOTPAccount(changed.applet, {id: '01020304'}, account, signal()),
    /Account changed, scan card 01020304 again/,
  );
  assert.deepEqual(changed.commands, [['list', {type: -3583}]]);
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const fixture = card({
      items: [accountRecord()],
      onRemove() {
        if (cancel) controller.abort();
        else throw new Error('Tag lost');
      },
    });
    await assert.rejects(
      removeOTPAccount(
        fixture.applet,
        {id: '01020304'},
        account,
        controller.signal,
      ),
      cancel ? {name: 'AbortError'} : /Tag lost/,
    );
    assert.deepEqual(fixture.commands, [
      ['list', {type: -3583}],
      ['remove', hex(accountIndex)],
    ]);
  }
});
