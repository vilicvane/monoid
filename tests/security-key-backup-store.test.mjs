import assert from 'node:assert/strict';
import {test} from 'node:test';

import {p256} from '@noble/curves/nist';
import {encode} from 'cbor2';
import {getBytes, sha256, toUtf8Bytes} from 'ethers';

import {
  SECURITY_KEY_AID,
  SECURITY_KEY_DOMAIN,
  readSecurityKeySnapshot,
} from '../.bld/app/@lib/security-key.js';
import {
  SecurityKeyBackupStore,
  securityKeyBackupAccountKey,
  securityKeyBackupDomainKey,
} from '../.bld/app/@services/security-key-backup-store.js';
// eslint-disable-next-line import/no-relative-packages -- Use the plugin's real argument and key-length validation over an in-memory native store.
import {createCloudKV} from '../plugins/cloud-kv/dist/esm/@client.js';

const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const seedIndex = bytes('02400102030405060708');
const publicKey = p256.getPublicKey(1n, false);
const scope = getBytes(sha256(publicKey));
const otherScope = getBytes(sha256(p256.getPublicKey(2n, false)));
const hello = {
  version: 1,
  id: bytes('11223344'),
  publicKey,
  bundle: false,
  authority: false,
  pins: {access: 5, secret: 5},
};

function credentialRecord({
  credentialId = new Uint8Array(32).fill(17),
  credentialScope = scope,
  alias,
} = {}) {
  const fields = new Map([
    [1, 1],
    [2, credentialId],
    [3, getBytes(sha256(toUtf8Bytes('example.com')))],
    [4, 'example.com'],
    [5, bytes('01234567')],
    [6, 'alice'],
    [8, true],
    [9, publicKey],
    [10, credentialScope],
  ]);
  return {
    index: Uint8Array.from([0xf1, 1, ...credentialId.subarray(0, 8)]),
    metadata: Uint8Array.from([...credentialScope, ...fields.get(3)]),
    secret: false,
    data: encode(fields),
    ...(alias !== undefined && {alias}),
  };
}

async function readSnapshot({records, granted = true}) {
  const applet = {
    listAppletGrants: async () => ({
      grants: granted
        ? [
            {
              aid: SECURITY_KEY_AID,
              types: [[-3839, true]],
              seed: {index: seedIndex, domain: SECURITY_KEY_DOMAIN},
              tokenHash: new Uint8Array(32),
            },
          ]
        : [],
    }),
    list: async () => ({
      items: [{index: seedIndex, secret: true}, ...records],
    }),
    get: async ({index}) => ({
      data: records.find(record => hex(record.index) === hex(index)).data,
    }),
    viewKey: async () => ({publicKey: p256.getPublicKey(1n, true)}),
    sendRawCommand: async () => new TextEncoder().encode('FIDO_2_0'),
  };
  return readSecurityKeySnapshot(applet, hello, new AbortController().signal);
}

function memoryBackend() {
  const values = new Map();
  const writes = [];
  const native = {
    async get({key}) {
      return {value: values.get(key) ?? null};
    },
    async set({key, value}) {
      writes.push(key);
      if (native.failure) {
        const failure = native.failure;
        native.failure = undefined;
        throw failure;
      }
      values.set(key, value);
    },
    async list({prefix = ''} = {}) {
      return {
        entries: [...values]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({key, value})),
      };
    },
  };
  return {kv: createCloudKV(native), native, values, writes};
}

test('scan snapshots retain the exact card bytes of valid credentials', async () => {
  const record = credentialRecord({alias: 'Work'});
  const result = await readSecurityKeySnapshot(
    {
      listAppletGrants: async () => ({grants: []}),
      list: async () => ({items: [record]}),
      get: async () => ({data: record.data}),
      sendRawCommand: async () => new TextEncoder().encode('FIDO_2_0'),
    },
    hello,
    new AbortController().signal,
  );
  assert.deepEqual(result.credentials[0].record, {
    metadata: record.metadata,
    data: record.data,
    alias: 'Work',
  });
  assert.notEqual(result.credentials[0].record.data, record.data);
});

test('saving stores one entry per credential and the active scope domain', async () => {
  const {kv, values, writes} = memoryBackend();
  const store = new SecurityKeyBackupStore(kv);
  const record = credentialRecord({alias: 'Work'});
  const snapshot = await readSnapshot({records: [record]});

  await store.save(snapshot);

  const accountKey = securityKeyBackupAccountKey(
    snapshot.credentials[0].credential,
  );
  assert.deepEqual([...values.keys()].sort(), [
    accountKey,
    securityKeyBackupDomainKey(scope),
  ]);
  assert.ok(accountKey.length <= 64);

  const [account, ...rest] = await store.list();
  assert.deepEqual(rest, []);
  assert.equal(account.index, hex(record.index));
  assert.deepEqual(account.metadata, record.metadata);
  assert.deepEqual(account.data, record.data);
  assert.equal(account.alias, 'Work');
  assert.equal(account.credential.rpId, 'example.com');
  assert.deepEqual(account.domain, SECURITY_KEY_DOMAIN);

  writes.length = 0;
  await store.save(snapshot);
  assert.deepEqual(writes, [], 'unchanged entries are not rewritten');
});

test('saving only adds or updates and keeps a known alias', async () => {
  const {kv} = memoryBackend();
  const store = new SecurityKeyBackupStore(kv);
  const first = credentialRecord({alias: 'Work'});
  const second = credentialRecord({credentialId: new Uint8Array(32).fill(18)});

  await store.save(await readSnapshot({records: [first, second]}));
  // Another card holds the same credential without an alias and lacks the second.
  await store.save(await readSnapshot({records: [{...first, alias: ''}]}));

  let accounts = await store.list();
  assert.equal(accounts.length, 2);
  assert.equal(
    accounts.find(account => account.index === hex(first.index)).alias,
    'Work',
  );

  await store.save(await readSnapshot({records: [{...first, alias: 'Home'}]}));
  accounts = await store.list();
  assert.equal(
    accounts.find(account => account.index === hex(first.index)).alias,
    'Home',
  );
});

test('an inactive scope is saved without guessing its domain', async () => {
  const {kv, values} = memoryBackend();
  const store = new SecurityKeyBackupStore(kv);
  const inactive = credentialRecord({
    credentialId: new Uint8Array(32).fill(19),
    credentialScope: otherScope,
  });

  await store.save(await readSnapshot({records: [inactive], granted: false}));
  assert.equal(values.size, 1);
  let [account] = await store.list();
  assert.equal(account.domain, undefined);

  // The active grant's domain belongs only to its own scope.
  await store.save(await readSnapshot({records: [inactive]}));
  [account] = await store.list();
  assert.equal(account.domain, undefined);
  assert.ok(values.has(securityKeyBackupDomainKey(scope)));
});

test('listing skips invalid, tampered or misplaced entries', async () => {
  const {kv, values} = memoryBackend();
  const store = new SecurityKeyBackupStore(kv);
  const record = credentialRecord();
  await store.save(await readSnapshot({records: [record]}));
  const [[key, value]] = [...values].filter(([entryKey]) =>
    entryKey.startsWith('sk1/'),
  );
  const fields = JSON.parse(value);

  values.set('sk1/misplaced', value);
  values.set('sk1/not-json', '{');
  values.set('sk1/version', JSON.stringify({...fields, v: 2}));
  // Data from another scope no longer matches the stored metadata.
  values.set(
    securityKeyBackupAccountKey({
      scope: otherScope,
      credentialId: new Uint8Array(32).fill(17),
    }),
    JSON.stringify({
      ...fields,
      data: Buffer.from(
        credentialRecord({credentialScope: otherScope}).data,
      ).toString('base64'),
    }),
  );
  values.set(securityKeyBackupDomainKey(otherScope), '{"v":1,"domain":1}');

  const accounts = await store.list();
  assert.equal(accounts.length, 1);
  assert.equal(securityKeyBackupAccountKey(accounts[0].credential), key);
});

test('a failed save rejects without blocking later saves', async () => {
  const {kv, native, values} = memoryBackend();
  const store = new SecurityKeyBackupStore(kv);
  const snapshot = await readSnapshot({records: [credentialRecord()]});

  native.failure = Object.assign(new Error('quota'), {code: 'QUOTA_EXCEEDED'});
  await assert.rejects(store.save(snapshot), {code: 'QUOTA_EXCEEDED'});
  await store.save(snapshot);
  assert.equal(values.size, 2);
});
