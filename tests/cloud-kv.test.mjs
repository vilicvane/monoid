import assert from 'node:assert/strict';
import {test} from 'node:test';

// eslint-disable-next-line import/no-relative-packages -- Exercise the private wrapper with a native mock, without registering Capacitor.
import {createCloudKV} from '../plugins/cloud-kv/dist/esm/@client.js';
// eslint-disable-next-line import/no-relative-packages -- The web fallback shares this quota check with the native limits.
import {checkQuota} from '../plugins/cloud-kv/dist/esm/@validation.js';

function mockNative() {
  const calls = [];
  const values = new Map();
  const native = {
    async getInfo() {
      return {backend: 'icloud', liveSync: true};
    },
    async get({key}) {
      calls.push(['get', key]);
      return {value: values.get(key) ?? null};
    },
    async set({key, value}) {
      calls.push(['set', key, value]);
      values.set(key, value);
    },
    async remove({key}) {
      calls.push(['remove', key]);
      values.delete(key);
    },
    async list({prefix = ''} = {}) {
      calls.push(['list', prefix]);
      return {
        entries: [...values]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({key, value})),
      };
    },
    async synchronize() {},
    async addListener() {
      return {remove: async () => {}};
    },
    async removeAllListeners() {},
  };

  return {native, calls, values};
}

async function assertCode(promise, code) {
  await assert.rejects(promise, error => error.code === code);
}

test('cloud kv passes valid values through and sorts listings', async () => {
  const {native} = mockNative();
  const kv = createCloudKV(native);

  await kv.set({key: 'sk1/b', value: ''});
  await kv.set({key: 'sk1/a', value: '🔑'});
  await kv.set({key: 'other', value: 'x'});

  assert.deepEqual(await kv.get({key: 'sk1/a'}), {value: '🔑'});
  assert.deepEqual(await kv.get({key: 'missing'}), {value: null});
  assert.deepEqual(await kv.list({prefix: 'sk1/'}), {
    entries: [
      {key: 'sk1/a', value: '🔑'},
      {key: 'sk1/b', value: ''},
    ],
  });
  assert.equal((await kv.list()).entries.length, 3);
});

test('cloud kv rejects invalid input before reaching native code', async () => {
  const {native, calls} = mockNative();
  const kv = createCloudKV(native);

  await assertCode(kv.get({key: ''}), 'INVALID_ARGUMENT');
  await assertCode(kv.set({key: 'a', value: 1}), 'INVALID_ARGUMENT');
  await assertCode(kv.set({key: 'a', value: '\ud800'}), 'INVALID_ARGUMENT');
  await assertCode(kv.set({key: 'a\udc00', value: ''}), 'INVALID_ARGUMENT');
  // 22 three-byte characters exceed 64 UTF-8 bytes in 22 UTF-16 code units.
  await assertCode(kv.remove({key: '钥'.repeat(22)}), 'INVALID_ARGUMENT');
  await assertCode(kv.list({prefix: 1}), 'INVALID_ARGUMENT');

  assert.deepEqual(calls, []);

  await kv.set({key: 'k'.repeat(64), value: ''});
  await kv.set({key: '钥'.repeat(21), value: ''});
  await kv.set({key: '🔑'.repeat(16), value: ''});
  assert.equal(calls.length, 3);
});

test('cloud kv quota counts replacements once', () => {
  const half = 'x'.repeat(500_000 - 1);
  const entries = [
    ['a', half],
    ['b', half],
  ];

  checkQuota(entries, 'a', half);
  assert.throws(() => checkQuota(entries, 'c', 'x'), {code: 'QUOTA_EXCEEDED'});

  const full = Array.from({length: 1024}, (_, index) => [`k${index}`, '']);
  checkQuota(full, 'k0', 'replaced');
  assert.throws(() => checkQuota(full, 'extra', ''), {
    code: 'QUOTA_EXCEEDED',
  });
});
