import assert from 'node:assert/strict';
import {test} from 'node:test';

import {CardBackupSession} from '../.bld/app/@components/views/safe/@card/card-backup-session.js';
import {CardSyncSession} from '../.bld/app/@components/views/safe/@card/card-sync-session.js';
import {
  encodeCardDerivationRecord,
  getCardDerivationItemIndex,
} from '../.bld/app/@components/views/safe/card-derivations.js';
import {scanCardItems} from '../.bld/app/@components/views/safe/scan-card.js';
import {InvalidCardItemError} from '../.bld/app/@lib/card-item-error.js';
import {readCardContents} from '../.bld/app/@lib/monoid/card-contents.js';
import {decodeOTPAccount} from '../.bld/app/@lib/otp.js';

import {credential} from './helpers/security-key-credential.mjs';

const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const signal = () => new AbortController().signal;

test('one filtered List shares incompatible indexes and progress without reading OTP secrets', async () => {
  const first = 'f2010000000000000001';
  const invalid = 'f2010000000000000002';
  const locked = 'f2010000000000000003';
  const requests = [];
  const progress = [];
  const applet = {
    async list(request) {
      requests.push(request);
      return {
        items: [
          {index: bytes(first), secret: true, metadata: bytes('010106001e')},
          {index: bytes(invalid), secret: true, metadata: bytes('ff')},
          {index: bytes(locked), secret: false, metadata: bytes('010106001e')},
        ],
      };
    },
    async get() {
      assert.fail('OTP secrets must not be read');
    },
  };
  const result = await readCardContents(applet, decodeOTPAccount, {
    filter: {type: -3583},
    onProgress: (...counts) => progress.push(counts),
  });
  assert.deepEqual(requests, [{type: -3583}]);
  assert.deepEqual(result, {
    items: [
      {
        index: first,
        label: 'OTP account',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
      },
    ],
    skippedIndexes: [invalid, locked],
  });
  assert.deepEqual(progress, [
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
  ]);
});

test('a supplied List is reused and ignored feature types do not count as incompatible', async () => {
  const result = await readCardContents(
    {list: () => assert.fail('Do not list twice')},
    () => undefined,
    {listed: {items: [{index: bytes('02400000000000000001'), secret: true}]}},
  );
  assert.deepEqual(result, {items: [], skippedIndexes: []});
});

test('transport, PIN, cancellation and unexpected decoder errors stop before the next item', async () => {
  for (const error of [
    new Error('NFC response lost'),
    Object.assign(new Error('Incorrect PIN'), {code: 'INVALID_PIN'}),
    Object.assign(new Error('Cancelled'), {code: 'CANCELLED'}),
    new TypeError('Decoder bug'),
  ]) {
    let reads = 0;
    await assert.rejects(
      readCardContents(
        {},
        () => {
          reads++;
          throw error;
        },
        {
          listed: {
            items: [1, 2].map(value => ({
              index: bytes(`1000000000000000000${value}`),
              secret: false,
            })),
          },
        },
      ),
      actual => actual === error,
    );
    assert.equal(reads, 1);
  }
});

test('cancellation during an incompatible read stays a cancellation and stops further Gets', async () => {
  const controller = new AbortController();
  let reads = 0;
  await assert.rejects(
    readCardContents(
      {},
      () => {
        reads++;
        controller.abort();
        throw new InvalidCardItemError('Invalid record');
      },
      {
        listed: {
          items: [1, 2].map(value => ({
            index: bytes(`1000000000000000000${value}`),
            secret: false,
          })),
        },
        check: () => controller.signal.throwIfAborted(),
      },
    ),
    {name: 'AbortError'},
  );
  assert.equal(reads, 1);
});

function mixedCard() {
  const key = {index: '03010000000000000001', type: 'secp256k1', secret: true};
  const derivation = index => ({
    index: getCardDerivationItemIndex(index),
    type: 0x0f01,
    secret: false,
    metadata: index,
    data: hex(encodeCardDerivationRecord({index, wallets: []})),
  });
  const records = [
    key,
    derivation(key.index),
    {index: 'f2010000000000000001', secret: true, metadata: '010106001e'},
    {index: 'f2010000000000000002', secret: true, metadata: 'ff'},
    credential(1),
    credential(2, {secret: true}),
    derivation('03010000000000000002'),
    {index: '10000000000000000001', secret: false, data: 'aa'},
    {index: '0f010000000000000001', secret: false, metadata: 'ff', data: 'ff'},
  ];
  const lists = [];
  const gets = [];
  return {
    records,
    lists,
    gets,
    hello: {
      id: bytes('00000001'),
      publicKey: bytes(`04${'11'.repeat(64)}`),
      bundle: false,
      pins: {access: 5, secret: 5},
    },
    async authenticate() {},
    async list(request) {
      lists.push(request);
      return {
        items: records.map(({data: _data, index, metadata, ...item}) => ({
          ...item,
          index: bytes(index),
          ...(metadata !== undefined && {metadata: bytes(metadata)}),
        })),
      };
    },
    async get({index}) {
      const record = records.find(item => item.index === hex(index));
      assert.equal(record.secret, false);
      gets.push(record.index);
      return {data: bytes(record.data)};
    },
    async viewKey() {
      return {
        publicKey: bytes(
          '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        ),
      };
    },
  };
}

test('scan, Copy and Sync share decoding while preserving payload reads, associations and skip counts', async () => {
  for (const flow of ['scan', 'copy', 'sync']) {
    const applet = mixedCard();
    const progress = [];
    let items;
    if (flow === 'scan') {
      items = await scanCardItems(
        applet,
        (...value) => progress.push(value),
        signal(),
      );
    } else if (flow === 'copy') {
      const session = new CardBackupSession();
      await session.readSource(
        applet,
        applet.hello,
        signal(),
        undefined,
        (...value) => progress.push(value),
      );
      items = session.backup.items;
    } else {
      const session = new CardSyncSession();
      const card = await session.add(
        applet,
        applet.hello,
        signal(),
        'Secret-42',
        value => progress.push(value),
      );
      items = card.items;
      assert.deepEqual(
        card.skippedIndexes,
        [3, 5, 8, 6].map(index => applet.records[index].index),
      );
    }
    assert.deepEqual(applet.lists, [{}]);
    const expected = [0, 1, 2, 4, ...(flow === 'copy' ? [6] : []), 7];
    assert.deepEqual(
      items.map(item => item.index),
      expected.map(index => applet.records[index].index),
    );
    assert.deepEqual(
      applet.gets,
      [1, 4, 6, ...(flow === 'sync' ? [7] : [])].map(
        index => applet.records[index].index,
      ),
    );
    const total = flow === 'sync' ? 9 : 7;
    assert.deepEqual(
      progress,
      Array.from({length: total + 1}, (_, current) =>
        flow === 'sync'
          ? {stage: 'reading', current, total}
          : flow === 'scan'
            ? [current, total, 'records']
            : [current, total],
      ),
    );
  }
});
