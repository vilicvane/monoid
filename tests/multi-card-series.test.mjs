import assert from 'node:assert/strict';
import {test} from 'node:test';

import {scanNextCards} from '../.bld/app/@components/@monoid/scan-next-cards.js';
import {MultiCardSeries} from '../.bld/app/@lib/monoid/multi-card-series.js';

test('completion uses public keys and records only acknowledged card operations', async () => {
  const finished = new Set(['first']);
  const series = new MultiCardSeries(finished);
  const failure = new Error('Uncertain write');
  let writes = 0;
  await assert.rejects(
    series.run('second', async () => {
      writes++;
      throw failure;
    }),
    error => error === failure,
  );
  assert.equal(writes, 1);
  assert.equal(series.completedCount, 1);
  assert.equal(series.hasFinished('second'), false);
  assert.equal(await series.run('second', async () => 'ACK'), 'ACK');
  assert.deepEqual([...finished], ['first', 'second']);
  await assert.rejects(
    series.run('second', async () => assert.fail('Already finished')),
    /Card already done/,
  );
  assert.equal(series.completedCount, 2);
});

test('finite flow progress derives from checkpoints and preserves caller-specific rejection text', () => {
  const cards = [
    {publicKey: 'first', complete: true},
    {publicKey: 'second', complete: false},
  ];
  assert.equal(MultiCardSeries.from(cards).completedCount, 1);
  assert.throws(
    () =>
      MultiCardSeries.from(cards).assertPending(
        'first',
        'Already copied to this card',
      ),
    /Already copied to this card/,
  );
  cards[1].complete = true;
  assert.equal(MultiCardSeries.from(cards).completedCount, 2);
  assert.equal(MultiCardSeries.from([]).completedCount, 0);
});

test('multi-card deletes stop on failure, keep finished cards and never replay a callback', async () => {
  const scanned = new Set();
  const failure = new Error('NFC response lost');
  let prompts = 0;
  let writes = 0;
  await assert.rejects(
    scanNextCards({
      scanned,
      content: 'Scan next card to delete',
      scan: async (_content, callback, validate) => {
        const hello = {
          id: new Uint8Array([1]),
          publicKey: new Uint8Array([++prompts]),
        };
        validate(hello);
        await callback({}, () => {}, hello, new AbortController().signal);
      },
      callback: async () => {
        if (++writes === 2) throw failure;
      },
    }),
    error => error === failure,
  );
  assert.deepEqual([...scanned], ['01']);
  assert.equal(prompts, 2);
  assert.equal(writes, 2);
});

test('finished cards are rejected before another delete and cancellation stays quiet', async () => {
  for (const code of ['CANCELLED', 'APP_INACTIVE']) {
    const scanned = new Set(['01']);
    await scanNextCards({
      scanned,
      content: 'Scan next card to delete',
      scan: async (_content, _callback, validate) => {
        assert.throws(
          () => validate({publicKey: new Uint8Array([1])}),
          /Card already done/,
        );
        throw Object.assign(new Error('Cancelled'), {code});
      },
      callback: () => assert.fail('Do not delete again'),
    });
    assert.deepEqual([...scanned], ['01']);
  }
});

test('a missing-item delete completes that card before cancellation ends the series', async () => {
  const controller = new AbortController();
  const scanned = new Set();
  await scanNextCards({
    scanned,
    signal: controller.signal,
    content: 'Scan next card to delete',
    scan: async (_content, callback, validate) => {
      const hello = {publicKey: new Uint8Array([1])};
      validate(hello);
      await callback({}, () => {}, hello, controller.signal);
      controller.abort();
    },
    callback: async () => undefined,
  });
  assert.deepEqual([...scanned], ['01']);
});
