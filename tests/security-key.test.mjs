import assert from 'node:assert/strict';
import {test} from 'node:test';

import {p256} from '@noble/curves/nist';
import {Tag, encode} from 'cbor2';
import {getBytes, sha256, toUtf8Bytes} from 'ethers';

import {AppletISOError, AppletNotFoundError} from '../.bld/app/@lib/applet.js';
import {CardItemNotFoundError} from '../.bld/app/@lib/cbor-applet.js';
import {
  SECURITY_KEY_AID,
  SECURITY_KEY_DOMAIN,
  SECURITY_KEY_ITEM_TYPE,
  SecurityKeyConfiguration,
  decodeSecurityKeyCredential,
  isSecurityKeyCredentialActive,
  readSecurityKeyScope,
  readSecurityKeySnapshot,
  securityKeySeedChangeNeedsConfirmation,
} from '../.bld/app/@lib/security-key.js';

const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const signal = () => new AbortController().signal;
const seedIndex = bytes('02400102030405060708');
const otherSeedIndex = bytes('02401112131415161718');
const id = new Uint8Array(32).fill(17);
const publicKey = p256.getPublicKey(1n, false);
const scope = getBytes(sha256(publicKey));
const hello = {
  version: 1,
  id: bytes('11223344'),
  publicKey,
  bundle: false,
  authority: false,
  pins: {access: 5, secret: 5},
};

function credentialFields() {
  return new Map([
    [1, 1],
    [2, id],
    [3, getBytes(sha256(toUtf8Bytes('example.com')))],
    [4, 'example.com'],
    [5, bytes('01234567')],
    [6, 'alice'],
    [7, 'Alice'],
    [9, publicKey],
    [10, scope],
  ]);
}
function credentialRecord(fields = credentialFields()) {
  return {
    index: Uint8Array.from([0xf1, 1, ...fields.get(2).subarray(0, 8)]),
    metadata: Uint8Array.from([...fields.get(10), ...fields.get(3)]),
    secret: false,
    data: encode(fields),
  };
}
function grant(index = seedIndex, domain = SECURITY_KEY_DOMAIN) {
  return {
    aid: SECURITY_KEY_AID,
    types: [[-3839, true]],
    seed: {index, domain},
    tokenHash: new Uint8Array(32).fill(33),
  };
}
function snapshot(overrides = {}) {
  return {
    hello,
    installed: true,
    seeds: [{index: hex(seedIndex)}],
    credentials: [],
    ...overrides,
  };
}
function card(state = {}) {
  const commands = [];
  const applet = {
    authenticate: async () =>
      assert.fail('Access authentication belongs to the scan'),
    listAppletGrants: async () => {
      commands.push(['grants']);
      return {grants: state.grants ?? []};
    },
    list: async request => {
      commands.push(['list', request]);
      const items = state.items ?? [
        {index: seedIndex, secret: true, type: 'seed'},
      ];
      return {
        items: items.filter(
          item =>
            request.type === undefined ||
            (request.type === 'seed'
              ? item.index[0] === 2
              : request.type === -3839 &&
                item.index[0] === 0xf1 &&
                item.index[1] === 1),
        ),
      };
    },
    createRandomKey: async request => {
      commands.push(['create', request]);
      return (await state.onCreate?.()) ?? {index: otherSeedIndex};
    },
    set: async request => {
      commands.push(['set', request]);
      await state.onSet?.();
      return {};
    },
    setAppletGrant: async request => {
      commands.push(['grant', request]);
      await state.onGrant?.();
      return {};
    },
    get: async request => {
      commands.push(['get', request]);
      return {data: state.data.get(hex(request.index))};
    },
    viewKey: async request => {
      commands.push(['viewKey', request]);
      return (
        (await state.onViewKey?.(request)) ?? {
          publicKey: p256.getPublicKey(1n, true),
        }
      );
    },
    select: async request => {
      commands.push(['raw', request]);
      return (await state.onSelect?.()) ?? toUtf8Bytes('FIDO_2_0');
    },
  };
  return {applet, commands};
}

test('decodes actual numeric-map credential fields and metadata association', () => {
  const record = credentialRecord();
  const decoded = decodeSecurityKeyCredential(
    record.data,
    record.index,
    record.metadata,
  );
  assert.equal(SECURITY_KEY_ITEM_TYPE, 0xf101);
  assert.deepEqual(decoded, {
    credentialId: id,
    rpHash: record.metadata.subarray(32),
    rpId: 'example.com',
    userId: bytes('01234567'),
    userName: 'alice',
    displayName: 'Alice',
    publicKey,
    scope,
  });
  const minimal = credentialFields();
  minimal.delete(6);
  minimal.delete(7);
  assert.equal(
    decodeSecurityKeyCredential(encode(minimal)).userName,
    undefined,
  );
});

for (const [name, mutate] of [
  ['unsupported version', fields => fields.set(1, 2)],
  ['missing version', fields => fields.delete(1)],
  ['text ID instead of bstr', fields => fields.set(2, '11'.repeat(32))],
  ['wrong ID length', fields => fields.set(2, new Uint8Array(31))],
  ['tagged ID instead of bstr', fields => fields.set(2, new Tag(64, id))],
  [
    'RP as bstr instead of text',
    fields => fields.set(4, toUtf8Bytes('example.com')),
  ],
  ['RP hash mismatch', fields => fields.set(4, 'other.example')],
  ['user ID as text', fields => fields.set(5, 'alice')],
  ['user name as bstr', fields => fields.set(6, toUtf8Bytes('alice'))],
  ['wrong public key length', fields => fields.set(9, new Uint8Array(64))],
  ['old record without scope', fields => fields.delete(10)],
  ['scope as text', fields => fields.set(10, hex(scope))],
  ['short scope', fields => fields.set(10, new Uint8Array(31))],
  ['long scope', fields => fields.set(10, new Uint8Array(33))],
  [
    'tagged scope instead of bstr',
    fields => fields.set(10, new Tag(64, scope)),
  ],
  [
    'invalid curve point',
    fields => fields.set(9, Uint8Array.from([4, ...new Uint8Array(64)])),
  ],
  [
    'string field names',
    fields => {
      const value = fields.get(2);
      fields.delete(2);
      fields.set('2', value);
    },
  ],
]) {
  test(`rejects ${name}`, () => {
    const fields = credentialFields();
    mutate(fields);
    assert.throws(
      () => decodeSecurityKeyCredential(encode(fields)),
      /Invalid Security Key credential/,
    );
  });
}

test('rejects duplicate fields, trailing data and mismatched index/metadata', () => {
  const record = credentialRecord();
  const encoded = encode(credentialFields());
  assert.equal(encoded[0], 0xa9);
  assert.throws(
    () =>
      decodeSecurityKeyCredential(
        Uint8Array.from([0xaa, ...encoded.subarray(1), 1, 1]),
      ),
    /Invalid/,
  );
  assert.throws(
    () => decodeSecurityKeyCredential(Uint8Array.from([...encoded, 0])),
    /Invalid/,
  );
  assert.throws(
    () => decodeSecurityKeyCredential(encoded, new Uint8Array(10)),
    /Invalid/,
  );
  assert.throws(
    () =>
      decodeSecurityKeyCredential(encoded, record.index, new Uint8Array(32)),
    /Invalid/,
  );
  for (const key of [
    record.metadata.subarray(32),
    Uint8Array.from([...new Uint8Array(32), ...record.metadata.subarray(32)]),
    Uint8Array.from([
      ...record.metadata.subarray(0, 32),
      ...new Uint8Array(32),
    ]),
    Uint8Array.from([...record.metadata, 0]),
  ]) {
    assert.throws(
      () => decodeSecurityKeyCredential(encoded, record.index, key),
      /Invalid/,
    );
  }
});

test('current scope uses the full SIO domain context and hashes the uncompressed P-256 point', async () => {
  const domain = bytes('ff00aabb');
  const {applet, commands} = card();
  assert.deepEqual(
    await readSecurityKeyScope(applet, {index: seedIndex, domain}, signal()),
    scope,
  );
  const request = commands[0][1];
  assert.equal(request.type, 'seed');
  assert.deepEqual(request.index, seedIndex);
  assert.equal(request.derivation.type, 'monoid-001');
  const expected = Buffer.concat([
    Buffer.from('monoid applet: ', 'ascii'),
    Buffer.from([0, 4]),
    Buffer.from(domain),
    Buffer.from('monoid fido2 scope: ', 'ascii'),
    Buffer.alloc(58),
  ]);
  assert.deepEqual(Buffer.from(request.derivation.context), expected);
  assert.notDeepEqual(scope, getBytes(sha256(p256.getPublicKey(1n, true))));
});

test('scope follows Seed-derived key contents, not the local Seed index or card identity', async () => {
  const {applet} = card();
  assert.deepEqual(
    await readSecurityKeyScope(applet, grant().seed, signal()),
    await readSecurityKeyScope(applet, grant(otherSeedIndex).seed, signal()),
  );
  const changed = card({
    onViewKey: async () => ({publicKey: p256.getPublicKey(2n, true)}),
  });
  assert.notDeepEqual(
    await readSecurityKeyScope(changed.applet, grant().seed, signal()),
    scope,
  );
  const invalid = card({
    onViewKey: async () => ({publicKey: new Uint8Array(33)}),
  });
  await assert.rejects(
    readSecurityKeyScope(invalid.applet, grant().seed, signal()),
  );
});

test('snapshot lists only 64-byte secret Seeds and never reads their contents', async () => {
  const record = credentialRecord();
  const malformed = {...record, index: bytes('f1010000000000000000')};
  const locked = {
    ...record,
    index: bytes('f1012222222222222222'),
    secret: true,
  };
  const {applet, commands} = card({
    grants: [grant()],
    items: [
      {index: seedIndex, secret: true, alias: 'Primary'},
      {index: bytes('02200000000000000000'), secret: true},
      {index: otherSeedIndex, secret: false},
      record,
      malformed,
      locked,
    ],
    data: new Map([
      [hex(record.index), record.data],
      [hex(malformed.index), bytes('00')],
    ]),
  });
  const result = await readSecurityKeySnapshot(applet, hello, signal());
  // One List serves both Seeds and credentials.
  assert.deepEqual(
    commands.filter(([name]) => name === 'list'),
    [['list', {}]],
  );
  assert.deepEqual(result.seeds, [{index: hex(seedIndex), alias: 'Primary'}]);
  assert.equal(result.installed, true);
  assert.deepEqual(result.scope, scope);
  assert.equal(result.credentials.length, 1);
  assert.equal(result.skippedCredentials, 2);
  assert.equal(securityKeySeedChangeNeedsConfirmation(result, 'create'), true);
  assert.equal(result.credentials[0].credential.rpId, 'example.com');
  assert.deepEqual(
    commands
      .filter(([name]) => name === 'get')
      .map(([, request]) => hex(request.index)),
    [hex(record.index), hex(malformed.index)],
  );
  assert.deepEqual(commands.at(-1)[1], SECURITY_KEY_AID);
  assert.equal(commands.filter(([name]) => name === 'viewKey').length, 1);
});

test('snapshot preserves multiple scopes and only the matching granted scope is available', async () => {
  const current = credentialRecord();
  const otherFields = credentialFields();
  otherFields.set(2, new Uint8Array(32).fill(22));
  otherFields.set(10, getBytes(sha256(p256.getPublicKey(2n, false))));
  const other = credentialRecord(otherFields);
  const {applet, commands} = card({
    grants: [grant()],
    items: [{index: seedIndex, secret: true}, current, other],
    data: new Map([current, other].map(item => [hex(item.index), item.data])),
  });
  const result = await readSecurityKeySnapshot(applet, hello, signal());
  assert.equal(result.credentials.length, 2);
  assert.equal(
    isSecurityKeyCredentialActive(result, result.credentials[0]),
    true,
  );
  assert.equal(
    isSecurityKeyCredentialActive(result, result.credentials[1]),
    false,
  );
  assert.equal(commands.filter(([name]) => name === 'viewKey').length, 1);
  for (const overrides of [
    {installed: false},
    {scope: undefined},
    {grant: {...result.grant, types: [[-3839, false]]}},
  ]) {
    assert.equal(
      isSecurityKeyCredentialActive(
        {...result, ...overrides},
        result.credentials[0],
      ),
      false,
    );
  }
});

test('missing granted Seed leaves scope unavailable without deriving or reading a secret', async () => {
  const {applet, commands} = card({grants: [grant()], items: []});
  const result = await readSecurityKeySnapshot(applet, hello, signal());
  assert.equal(result.scope, undefined);
  assert.equal(
    commands.some(([name]) => name === 'viewKey' || name === 'get'),
    false,
  );
});

test('only explicit FIDO SELECT not-found is reported as missing', async () => {
  {
    const missing = card({
      onSelect: async () => {
        throw new AppletNotFoundError(new Uint8Array(), SECURITY_KEY_AID);
      },
    });
    assert.equal(
      (await readSecurityKeySnapshot(missing.applet, hello, signal()))
        .installed,
      false,
    );
  }
  const unexpected = card({
    onSelect: async () => {
      throw new AppletISOError('failed', 0x6985, new Uint8Array());
    },
  });
  await assert.rejects(
    readSecurityKeySnapshot(unexpected.applet, hello, signal()),
    error => error.sw === 0x6985,
  );
});

test('configuration verifies full identity before reading or writing items', async () => {
  for (const wrong of [
    {...hello, id: bytes('99887766')},
    {...hello, publicKey: p256.getPublicKey(2n, false)},
  ]) {
    const {applet, commands} = card();
    const configuration = new SecurityKeyConfiguration(
      snapshot(),
      hex(seedIndex),
    );
    await assert.rejects(
      configuration.apply(applet, wrong, signal()),
      hex(wrong.id) === hex(hello.id)
        ? /was reset or reinstalled/
        : /Wrong card/,
    );
    assert.deepEqual(commands, []);
  }
});

test('new binding uses only F101 write and 64-byte Seed with the default domain, never copies a token', async () => {
  const {applet, commands} = card();
  const configuration = new SecurityKeyConfiguration(
    snapshot(),
    hex(seedIndex),
  );
  await configuration.apply(applet, hello, signal());
  assert.deepEqual(
    commands.map(([name]) => name),
    ['grants', 'list', 'grant'],
  );
  assert.deepEqual(commands.at(-1)[1], {
    aid: SECURITY_KEY_AID,
    types: [[-3839, true]],
    seed: {index: seedIndex, domain: SECURITY_KEY_DOMAIN},
  });
  assert.equal(configuration.complete, true);
});

test('existing binding preserves the original byte domain when changing or reenrolling a Seed', async () => {
  const previous = grant(seedIndex, bytes('ff00aabb'));
  const {applet, commands} = card({
    grants: [previous],
    items: [{index: otherSeedIndex, secret: true}],
  });
  await new SecurityKeyConfiguration(
    snapshot({grant: previous}),
    hex(otherSeedIndex),
  ).apply(applet, hello, signal());
  assert.deepEqual(commands.at(-1)[1].seed, {
    index: otherSeedIndex,
    domain: previous.seed.domain,
  });
  assert.equal('tokenHash' in commands.at(-1)[1], false);
});

test('changed configuration aborts before creating a Seed or replacing a grant', async () => {
  const {applet, commands} = card({grants: [grant(otherSeedIndex)]});
  const configuration = new SecurityKeyConfiguration(
    snapshot({grant: grant()}),
    'create',
  );
  await assert.rejects(
    configuration.apply(applet, hello, signal()),
    /configuration changed/,
  );
  assert.deepEqual(
    commands.map(([name]) => name),
    ['grants'],
  );
});

test('rejects unavailable or incorrectly sized selected Seeds without granting access', async () => {
  const {applet, commands} = card({items: [{index: seedIndex, secret: false}]});
  await assert.rejects(
    new SecurityKeyConfiguration(snapshot(), hex(seedIndex)).apply(
      applet,
      hello,
      signal(),
    ),
    /64-byte Seed not found/,
  );
  assert.equal(
    commands.some(([name]) => name === 'grant'),
    false,
  );
});

test('acknowledged Seed creation is retained when alias writing fails and explicit continuation reuses it', async () => {
  let fail = true;
  const {applet, commands} = card({
    onSet: async () => {
      if (fail) {
        fail = false;
        throw new Error('lost connection');
      }
    },
  });
  const configuration = new SecurityKeyConfiguration(snapshot(), 'create');
  await assert.rejects(
    configuration.apply(applet, hello, signal()),
    /lost connection/,
  );
  assert.deepEqual(configuration.createdIndex, otherSeedIndex);
  assert.equal(configuration.uncertain, false);
  await configuration.apply(applet, hello, signal());
  assert.equal(commands.filter(([name]) => name === 'create').length, 1);
  assert.deepEqual(commands.find(([name]) => name === 'create')[1], {
    type: 'seed',
    length: 64,
  });
  assert.deepEqual(commands.find(([name]) => name === 'set')[1], {
    index: otherSeedIndex,
    alias: 'Security Key',
  });
  assert.equal(configuration.complete, true);
});

for (const stage of ['Create', 'Grant']) {
  test(`unknown ${stage.toLowerCase()} outcome cannot be replayed`, async () => {
    const {applet, commands} = card({
      [`on${stage}`]: async () => {
        throw new Error('lost ACK');
      },
    });
    const configuration = new SecurityKeyConfiguration(
      snapshot(),
      stage === 'Create' ? 'create' : hex(seedIndex),
    );
    await assert.rejects(
      configuration.apply(applet, hello, signal()),
      /lost ACK/,
    );
    assert.equal(configuration.uncertain, true);
    const count = commands.length;
    await assert.rejects(
      configuration.apply(applet, hello, signal()),
      /Scan card 11223344 again to check changes/,
    );
    assert.equal(commands.length, count);
  });
}

test('known card rejection does not turn into an unknown write result', async () => {
  const {applet} = card({
    onGrant: async () => {
      throw new CardItemNotFoundError({code: 'NOT_FOUND'});
    },
  });
  const configuration = new SecurityKeyConfiguration(
    snapshot(),
    hex(seedIndex),
  );
  await assert.rejects(
    configuration.apply(applet, hello, signal()),
    /NOT_FOUND/,
  );
  assert.equal(configuration.uncertain, false);
});

test('acknowledgement survives cancellation before cleanup; no second grant is sent', async () => {
  const controller = new AbortController();
  const {applet, commands} = card({
    onGrant: async () => {
      controller.abort();
    },
  });
  const configuration = new SecurityKeyConfiguration(
    snapshot(),
    hex(seedIndex),
  );
  await configuration.apply(applet, hello, controller.signal);
  assert.equal(configuration.complete, true);
  await configuration.apply(applet, hello, signal());
  assert.equal(commands.filter(([name]) => name === 'grant').length, 1);
});

test('changing an already configured Seed requires confirmation', () => {
  // Without records, non-resident credentials may still depend on the Seed.
  for (const records of [
    {credentials: [{index: 'f1010000000000000000'}]},
    {skippedCredentials: 1},
    {},
  ]) {
    const current = snapshot({...records, grant: grant()});
    assert.equal(
      securityKeySeedChangeNeedsConfirmation(current, hex(seedIndex)),
      false,
    );
    assert.equal(
      securityKeySeedChangeNeedsConfirmation(current, hex(otherSeedIndex)),
      true,
    );
    assert.equal(
      securityKeySeedChangeNeedsConfirmation(current, 'create'),
      true,
    );
  }
});

for (const [name, currentGrant] of [
  ['no grant', undefined],
  ['a grant without a Seed', {...grant(), seed: undefined}],
]) {
  test(`first enable with ${name} does not warn or block on existing or skipped credentials`, async () => {
    const record = credentialRecord();
    for (const records of [
      {credentials: [{index: hex(record.index)}]},
      {skippedCredentials: 1},
    ]) {
      for (const selection of [hex(seedIndex), 'create']) {
        const current = snapshot({...records, grant: currentGrant});
        assert.equal(
          securityKeySeedChangeNeedsConfirmation(current, selection),
          false,
        );
        const {applet, commands} = card({
          grants: currentGrant ? [currentGrant] : [],
          items: [{index: seedIndex, secret: true}, record],
        });
        const configuration = new SecurityKeyConfiguration(current, selection);
        await configuration.apply(applet, hello, signal());
        assert.equal(configuration.complete, true);
        assert.deepEqual(commands.at(-1), [
          'grant',
          {
            aid: SECURITY_KEY_AID,
            types: [[-3839, true]],
            seed: {
              index: selection === 'create' ? otherSeedIndex : seedIndex,
              domain: SECURITY_KEY_DOMAIN,
            },
          },
        ]);
      }
    }
  });

  test(`first enable with ${name} rejects a Seed configured after the initial read`, async () => {
    const {applet, commands} = card({grants: [grant(otherSeedIndex)]});
    const configuration = new SecurityKeyConfiguration(
      snapshot({grant: currentGrant}),
      'create',
    );
    await assert.rejects(
      configuration.apply(applet, hello, signal()),
      /configuration changed, scan card 11223344 again/,
    );
    assert.deepEqual(
      commands.map(([name]) => name),
      ['grants'],
    );
  });
}

test('credentials added after reading the card cannot bypass Seed-change confirmation', async () => {
  const previous = grant();
  const current = snapshot({grant: previous});
  const {applet, commands} = card({
    grants: [previous],
    items: [credentialRecord()],
  });
  const configuration = new SecurityKeyConfiguration(current, 'create');
  await assert.rejects(
    configuration.apply(applet, hello, signal()),
    /Credentials changed, scan card 11223344 again/,
  );
  assert.equal(
    commands.some(([name]) => name === 'create' || name === 'grant'),
    false,
  );
  await new SecurityKeyConfiguration(current, 'create', true).apply(
    applet,
    hello,
    signal(),
  );
  assert.equal(commands.filter(([name]) => name === 'create').length, 1);
});

test('cancelled configuration does not issue commands on an authenticated card', async () => {
  const controller = new AbortController();
  controller.abort();
  const {applet, commands} = card();
  await assert.rejects(
    new SecurityKeyConfiguration(snapshot(), 'create').apply(
      applet,
      hello,
      controller.signal,
    ),
    {name: 'AbortError'},
  );
  assert.deepEqual(commands, []);
});
