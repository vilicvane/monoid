import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

import {p256} from '@noble/curves/nist';
import {getBytes, sha256, toUtf8Bytes} from 'ethers';

let otp;
const OTP_AID = Uint8Array.from(Buffer.from('f06d6f6e6f69640501', 'hex'));
mock.module('../.bld/app/@lib/otp-applet.js', {
  namedExports: {
    OTP_AID,
    createOTPApplet: () => ({useSession: async () => otp}),
  },
});
const {AppletISOError, AppletNotFoundError} = await import(
  '../.bld/app/@lib/applet.js'
);
const {
  addOTPAccount,
  assertOTPAccounts,
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
const accountIndex = bytes('f2010102030405060708');
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
    secret: false,
    data: hmacIndex,
    ...overrides,
  };
}
function grant(keys = [hmacIndex], overrides = {}) {
  return {
    aid: OTP_AID,
    tokenHash: new Uint8Array(32),
    types: [[-3583, false]],
    keys: keys.map(index => ({index, type: 'hmac'})),
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
    async hello() {
      commands.push(['otp.hello']);
      if (options.notInstalled) throw new AppletNotFoundError(new Uint8Array());
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
      if (!item) throw new Error('NOT_FOUND');
      const {data: _data, ...metadata} = item;
      return metadata;
    },
    async list(request) {
      commands.push(['list', request]);
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
      if (!item) throw new Error('NOT_FOUND');
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
      if ('type' in request) {
        assert.equal(
          request.type,
          'hmac',
          'custom OTP metadata requires an explicit index',
        );
      }
      const index =
        request.index ??
        new Uint8Array([
          5,
          request.data.length,
          ...getBytes(sha256(request.data)).subarray(0, 8),
        ]);
      assert.ok(
        !items.has(hex(index)),
        'firmware rejects duplicate create rather than returning the old HMAC key',
      );
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
      assert.ok(items.delete(hex(index)));
      await options.onRemove?.(index);
      return {};
    },
  };
  return {applet, commands, items};
}

test('OTP preflight only probes Hello and distinguishes absence from failures', async () => {
  for (const notInstalled of [false, true]) {
    const {applet, commands} = card({notInstalled});
    assert.equal(await isOTPInstalled(applet, signal()), !notInstalled);
    assert.deepEqual(commands, [['otp.hello']]);
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

test('OTP list reads only public metadata references and returns no secrets or grant tokens', async () => {
  const fixture = card({
    items: [accountRecord(), {index: hmacIndex, secret: true, data: secret}],
  });
  const accounts = await readOTPAccounts(fixture.applet, signal());
  assert.deepEqual(accounts, [
    {
      index: hex(accountIndex),
      label: 'Example: alice',
      ...configuration,
      keyIndex: hex(hmacIndex),
    },
  ]);
  assert.deepEqual(fixture.commands, [
    ['list', {type: -3583}],
    ['list', {type: 'hmac'}],
    ['get', hex(accountIndex)],
  ]);
  assert.ok(!JSON.stringify(accounts).includes(hex(secret)));
});

test('adding an account reads each OTP reference once and grants the resulting snapshot', async () => {
  const fixture = card({
    items: [
      accountRecord(),
      {index: hmacIndex, secret: true, data: secret},
      {index: bytes('01400102030405060708'), secret: true, data: secret},
    ],
  });
  const next = await addOTPAccount(
    fixture.applet,
    {
      ...configuration,
      secret,
      label: 'Example: second',
      digits: 8,
    },
    signal(),
    () => {},
  );
  assert.equal(next.length, 2);
  assert.deepEqual(
    fixture.commands.map(command => command[0]),
    ['list', 'list', 'get', 'create', 'grant'],
  );
  assert.deepEqual(
    fixture.commands
      .filter(command => command[0] === 'list')
      .map(command => command[1]),
    [{type: -3583}, {type: 'hmac'}],
  );
  assert.equal(next[1].digits, 8);
  assert.equal(fixture.commands.at(-1)[1].keys.length, 1);
  assert.deepEqual(await readOTPAccounts(fixture.applet, signal()), next);
});

test('removing an account grants the remaining snapshot without rereading references', async () => {
  const fixture = card({
    items: [
      accountRecord(),
      accountRecord(secondIndex),
      {index: hmacIndex, secret: true, data: secret},
    ],
  });
  const account = {
    index: hex(accountIndex),
    keyIndex: hex(hmacIndex),
    label: 'Example: alice',
    ...configuration,
  };
  const next = await removeOTPAccount(
    fixture.applet,
    account,
    signal(),
    () => {},
  );
  assert.deepEqual(
    next.map(account => account.index),
    [hex(secondIndex)],
  );
  assert.deepEqual(
    fixture.commands.map(command => command[0]),
    ['list', 'list', 'get', 'get', 'grants', 'remove', 'grant'],
  );
});

test('an incompatible record at the proposed index is never treated as absent', async () => {
  const fixture = card();
  const imported = {...configuration, secret, label: 'Example'};
  const [created] = await addOTPAccount(
    fixture.applet,
    imported,
    signal(),
    () => {},
  );
  fixture.items.get(created.index).metadata = new Uint8Array([9]);
  fixture.commands.length = 0;
  await assert.rejects(
    addOTPAccount(fixture.applet, imported, signal(), () => {}),
    /OTP account conflict/,
  );
  assert.equal(
    fixture.commands.some(command =>
      ['create', 'set', 'grant'].includes(command[0]),
    ),
    false,
  );
});

test('OTP list skips incompatible accounts and retains supported accounts', async () => {
  for (const override of [
    {secret: true},
    {metadata: undefined},
    {metadata: new Uint8Array()},
    {metadata: new Uint8Array([2, 1, 6, 0, 30])},
    {metadata: new Uint8Array([1, 4, 6, 0, 30])},
    {metadata: new Uint8Array([1, 1, 7, 0, 30])},
    {metadata: new Uint8Array([1, 1, 6, 0, 0])},
    {metadata: new Uint8Array([1, 1, 6, 128, 0])},
    {data: bytes('02400102030405060708')},
  ]) {
    const fixture = card({
      items: [
        accountRecord(accountIndex, override),
        accountRecord(secondIndex),
        {index: hmacIndex, secret: true, data: secret},
      ],
    });
    const accounts = await readOTPAccounts(fixture.applet, signal());
    assert.deepEqual(
      accounts.map(item => item.index),
      [hex(secondIndex)],
    );
    if (override.secret)
      assert.ok(
        !fixture.commands.some(
          ([name, index]) => name === 'get' && index === hex(accountIndex),
        ),
      );
  }
});

test('OTP list skips orphaned accounts but propagates communication and permission errors', async () => {
  for (const parent of [undefined, {index: hmacIndex, secret: false}]) {
    const fixture = card({
      items: [accountRecord(), ...(parent ? [parent] : [])],
    });
    assert.deepEqual(await readOTPAccounts(fixture.applet, signal()), []);
  }
  const fixture = card({
    items: [accountRecord(), {index: hmacIndex, secret: true}],
  });
  for (const failure of [
    new Error('Tag lost'),
    new AppletISOError('Denied', 0x6982, new Uint8Array()),
  ]) {
    fixture.applet.get = async () => {
      throw failure;
    };
    await assert.rejects(
      readOTPAccounts(fixture.applet, signal()),
      error => error === failure,
    );
  }
});

test('retrieval uses cached metadata and checks the key reference with one get', async () => {
  const fixture = card({
    items: [accountRecord(), {index: hmacIndex, secret: true, data: secret}],
  });
  await assertOTPAccounts(
    fixture.applet,
    [
      {
        ...configuration,
        index: hex(accountIndex),
        keyIndex: hex(hmacIndex),
        label: 'Cached label',
      },
    ],
    signal(),
  );
  assert.deepEqual(fixture.commands, [['get', hex(accountIndex)]]);
});

test('a matching index with a different HMAC reference or protected data is rejected', async () => {
  for (const override of [
    {secret: true},
    {data: bytes('05141112131415161718')},
  ]) {
    const fixture = card({items: [accountRecord(accountIndex, override)]});
    await assert.rejects(
      assertOTPAccounts(
        fixture.applet,
        [
          {
            ...configuration,
            index: hex(accountIndex),
            keyIndex: hex(hmacIndex),
            label: 'Cached label',
          },
        ],
        signal(),
      ),
      override.secret ? /ACCESS_DENIED/ : /OTP account does not match/,
    );
    assert.deepEqual(fixture.commands, [['get', hex(accountIndex)]]);
  }
});

test('selected account checks propagate missing records, transport errors and cancellation', async () => {
  const selected = [
    {
      ...configuration,
      index: hex(accountIndex),
      keyIndex: hex(hmacIndex),
      label: 'Cached label',
    },
  ];
  const missing = card();
  await assert.rejects(
    assertOTPAccounts(missing.applet, selected, signal()),
    /NOT_FOUND/,
  );
  const failure = new Error('Tag lost');
  const interrupted = card();
  interrupted.applet.get = async () => {
    throw failure;
  };
  await assert.rejects(
    assertOTPAccounts(interrupted.applet, selected, signal()),
    error => error === failure,
  );
  const cancelled = card({items: [accountRecord()]});
  const controller = new AbortController();
  const get = cancelled.applet.get;
  cancelled.applet.get = async request => {
    const result = await get(request);
    controller.abort();
    return result;
  };
  await assert.rejects(
    assertOTPAccounts(cancelled.applet, selected, controller.signal),
    {name: 'AbortError'},
  );
  assert.deepEqual(cancelled.commands, [['get', hex(accountIndex)]]);
});

test('OTP card authorization probes the installation token rather than trusting persisted grants', async () => {
  const state = {
    items: [accountRecord(), {index: hmacIndex, secret: true, data: secret}],
    grants: [grant()],
  };
  const valid = card(state);
  const cached = await readOTPCard(valid.applet, hello, signal());
  assert.equal(cached.installed, true);
  assert.equal(cached.authorized, true);
  assert.deepEqual(valid.commands.slice(-2), [
    ['otp.hello'],
    ['otp.challenge'],
  ]);
  assert.ok(!('grant' in cached));
  assert.ok(!('tokenHash' in cached));
  const stale = card({
    ...state,
    challengeError: new AppletISOError('stale token', 0x6982, new Uint8Array()),
  });
  assert.equal(
    (await readOTPCard(stale.applet, hello, signal())).authorized,
    false,
  );
  const missing = card({...state, notInstalled: true});
  assert.equal(
    (await readOTPCard(missing.applet, hello, signal())).installed,
    false,
  );
  const interrupted = card({...state, challengeError: new Error('Tag lost')});
  await assert.rejects(
    readOTPCard(interrupted.applet, hello, signal()),
    /Tag lost/,
  );
});

test('OTP authorization requires each exact HMAC key and read permission, deduplicating shared keys', async () => {
  const incomplete = card({
    items: [accountRecord(), {index: hmacIndex, secret: true, data: secret}],
    grants: [grant([])],
  });
  assert.equal(
    (await readOTPCard(incomplete.applet, hello, signal())).authorized,
    false,
  );
  assert.equal(
    incomplete.commands.some(command => command[0] === 'otp.challenge'),
    false,
  );
  const fixture = card({
    items: [
      accountRecord(),
      accountRecord(secondIndex, {metadata: new Uint8Array([1, 3, 8, 0, 60])}),
      {index: hmacIndex, secret: true, data: secret},
    ],
  });
  await authorizeOTPAccounts(fixture.applet, signal());
  const written = fixture.commands.at(-1)[1];
  assert.deepEqual(written, {
    aid: OTP_AID,
    types: [[-3583, false]],
    keys: [{index: hmacIndex, type: 'hmac'}],
  });
});

test('OTP account import uses explicit metadata indices and reuses the same protected HMAC key', async () => {
  const fixture = card();
  let mutations = 0;
  const first = {label: 'Example: alice', secret, ...configuration};
  await addOTPAccount(fixture.applet, first, signal(), () => mutations++);
  await addOTPAccount(
    fixture.applet,
    {...first, label: 'Example: other', period: 60},
    signal(),
    () => mutations++,
  );
  const creates = fixture.commands
    .filter(command => command[0] === 'create')
    .map(command => command[1]);
  assert.equal(creates.filter(request => request.type === 'hmac').length, 1);
  assert.equal(
    creates.filter(request => request.index?.[0] === 0xf2).length,
    2,
  );
  assert.deepEqual(
    creates
      .filter(request => request.index?.[0] === 0xf2)
      .map(request => ({
        metadata: request.metadata,
        data: request.data,
        key: request.key,
      })),
    [30, 60].map(period => ({
      metadata: new Uint8Array([1, 1, 6, 0, period]),
      data: hmacIndex,
      key: undefined,
    })),
  );
  assert.equal(fixture.items.size, 3);
  assert.equal(mutations, 2);
});

test('reimport updates an existing account alias and preserves its original metadata index', async () => {
  const fixture = card({
    items: [accountRecord(), {index: hmacIndex, secret: true, data: secret}],
  });
  await addOTPAccount(
    fixture.applet,
    {label: 'Renamed', secret, ...configuration},
    signal(),
    () => {},
  );
  assert.equal(
    fixture.commands.some(command => command[0] === 'create'),
    false,
  );
  assert.equal(fixture.items.get(hex(accountIndex)).alias, 'Renamed');
  assert.deepEqual(fixture.commands.find(command => command[0] === 'set')[1], {
    index: accountIndex,
    alias: 'Renamed',
  });
});

test('OTP metadata index conflicts never replace unrelated data', async () => {
  // Domain-separated SHA-256 vector for SHA1/6/30 and RFC 6238's SHA1 secret.
  const conflicting = accountRecord(bytes('f201e389217b1b478af1'), {
    metadata: new Uint8Array([1, 3, 8, 0, 60]),
  });
  const fixture = card({
    items: [conflicting, {index: hmacIndex, secret: true, data: secret}],
  });
  await assert.rejects(
    addOTPAccount(
      fixture.applet,
      {label: 'Example', secret, ...configuration},
      signal(),
      () => {},
    ),
    /conflict/,
  );
  assert.equal(
    fixture.commands.some(command =>
      ['create', 'set', 'grant'].includes(command[0]),
    ),
    false,
  );
  assert.deepEqual(fixture.items.get(hex(conflicting.index)), conflicting);
});

test('OTP grant can authorize more accounts than the per-calculation batch limit', async () => {
  const items = Array.from({length: 17}, (_, value) =>
    accountRecord(
      bytes(`f20100000000000000${value.toString(16).padStart(2, '0')}`),
      {data: bytes(`051400000000000000${value.toString(16).padStart(2, '0')}`)},
    ),
  );
  const fixture = card({
    items: [...items, ...items.map(item => ({index: item.data, secret: true}))],
  });
  await authorizeOTPAccounts(fixture.applet, signal());
  assert.equal(fixture.commands.at(-1)[1].keys.length, 17);
});

test('OTP import never replaces an existing unprotected HMAC and does not replay uncertain writes', async () => {
  const unprotected = card({
    items: [{index: hmacIndex, secret: false, data: secret}],
  });
  await assert.rejects(
    addOTPAccount(
      unprotected.applet,
      {label: 'Example', secret, ...configuration},
      signal(),
      () => {},
    ),
    /not protected/,
  );
  assert.equal(
    unprotected.commands.some(command =>
      ['create', 'set', 'grant'].includes(command[0]),
    ),
    false,
  );
  let mutations = 0;
  const interrupted = card({
    onCreate() {
      throw new Error('Tag lost');
    },
  });
  await assert.rejects(
    addOTPAccount(
      interrupted.applet,
      {label: 'Example', secret, ...configuration},
      signal(),
      () => mutations++,
    ),
    /Tag lost/,
  );
  assert.equal(
    interrupted.commands.filter(command => command[0] === 'create').length,
    1,
  );
  assert.equal(
    interrupted.commands.some(command => command[0] === 'grant'),
    false,
  );
  assert.equal(mutations, 1);
});

test('OTP import cancellation after creating the HMAC does not write metadata or replay', async () => {
  const controller = new AbortController();
  const fixture = card({
    onCreate() {
      controller.abort();
    },
  });
  let mutations = 0;
  await assert.rejects(
    addOTPAccount(
      fixture.applet,
      {label: 'Example', secret, ...configuration},
      controller.signal,
      () => mutations++,
    ),
  );
  assert.equal(
    fixture.commands.filter(command => command[0] === 'create').length,
    1,
  );
  assert.equal(
    fixture.commands.some(command => command[0] === 'grant'),
    false,
  );
  assert.ok(fixture.items.has(hex(hmacIndex)));
  assert.equal(mutations, 1);
});

test('OTP delete removes metadata before an unshared HMAC key and refreshes the grant', async () => {
  const fixture = card({
    items: [accountRecord(), {index: hmacIndex, secret: true, data: secret}],
    grants: [grant()],
  });
  const [account] = await readOTPAccounts(fixture.applet, signal());
  let mutations = 0;
  await removeOTPAccount(fixture.applet, account, signal(), () => mutations++);
  assert.deepEqual(
    fixture.commands
      .filter(command => command[0] === 'remove')
      .map(command => command[1]),
    [hex(accountIndex), hex(hmacIndex)],
  );
  assert.deepEqual(fixture.commands.at(-1), [
    'grant',
    {aid: OTP_AID, types: [[-3583, false]], keys: []},
  ]);
  assert.equal(mutations, 1);
});

test('OTP delete preserves HMAC keys referenced by another account or applet', async () => {
  for (const sharedByAccount of [true, false]) {
    const fixture = card({
      items: [
        accountRecord(),
        {index: hmacIndex, secret: true, data: secret},
        ...(sharedByAccount ? [accountRecord(secondIndex)] : []),
      ],
      grants: [
        grant(),
        ...(sharedByAccount
          ? []
          : [grant([hmacIndex], {aid: bytes('0102030405')})]),
      ],
    });
    const [account] = await readOTPAccounts(fixture.applet, signal());
    await removeOTPAccount(fixture.applet, account, signal(), () => {});
    assert.ok(fixture.items.has(hex(hmacIndex)));
    assert.deepEqual(
      fixture.commands
        .filter(command => command[0] === 'remove')
        .map(command => command[1]),
      [hex(accountIndex)],
    );
  }
});

test('OTP account deletion still works after the optional applet was removed', async () => {
  const fixture = card({
    items: [accountRecord(), {index: hmacIndex, secret: true, data: secret}],
  });
  const [account] = await readOTPAccounts(fixture.applet, signal());
  await removeOTPAccount(fixture.applet, account, signal(), () => {}, false);
  assert.equal(fixture.items.size, 0);
  assert.equal(
    fixture.commands.some(command => command[0] === 'grant'),
    false,
  );
});

test('OTP deletion retains a secret that may still belong to an incompatible account', async () => {
  const fixture = card({
    items: [
      accountRecord(),
      accountRecord(secondIndex, {metadata: Uint8Array.of(2, 1, 6, 0, 30)}),
      {index: hmacIndex, secret: true, data: secret},
    ],
  });
  const [account] = await readOTPAccounts(fixture.applet, signal());
  await removeOTPAccount(fixture.applet, account, signal(), () => {});
  assert.ok(fixture.items.has(hex(hmacIndex)));
  assert.ok(fixture.items.has(hex(secondIndex)));
  assert.deepEqual(
    fixture.commands
      .filter(([name]) => name === 'remove')
      .map(([, index]) => index),
    [hex(accountIndex)],
  );
});

test('OTP delete rejects a changed key reference and stops on an uncertain metadata deletion', async () => {
  const changed = card({
    items: [accountRecord(), {index: hmacIndex, secret: true, data: secret}],
  });
  const [account] = await readOTPAccounts(changed.applet, signal());
  await assert.rejects(
    removeOTPAccount(
      changed.applet,
      {...account, keyIndex: '05141112131415161718'},
      signal(),
      () => {},
    ),
    /changed/,
  );
  assert.equal(
    changed.commands.some(command => command[0] === 'remove'),
    false,
  );
  let mutations = 0;
  const interrupted = card({
    items: [accountRecord(), {index: hmacIndex, secret: true, data: secret}],
    onRemove() {
      throw new Error('Tag lost');
    },
  });
  await assert.rejects(
    removeOTPAccount(interrupted.applet, account, signal(), () => mutations++),
    /Tag lost/,
  );
  assert.deepEqual(
    interrupted.commands
      .filter(command => command[0] === 'remove')
      .map(command => command[1]),
    [hex(accountIndex)],
  );
  assert.ok(interrupted.items.has(hex(hmacIndex)));
  assert.equal(mutations, 1);
});
