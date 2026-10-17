import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  DAY_SECONDS,
  SAMPLE_INTERVAL_SECONDS as INTERVAL,
  WEEK_SECONDS,
  addSample,
  summarizeHistory,
} from '../.bld/history.js';

const now = 1800000000;

function history(count, end = now, fee = index => BigInt(index + 1)) {
  return Array.from({length: count}, (_, index) => ({
    timestamp: end - (count - index - 1) * INTERVAL,
    blockNumber: String(index + 1),
    baseFeePerGas: fee(index).toString(),
  }));
}

test('a full day yields exact nearest-rank percentiles and continues collecting a week', () => {
  const result = summarizeHistory(history(288), now);

  assert.deepEqual(result.windows['24h'], {
    from: now - DAY_SECONDS,
    to: now,
    sampleCount: 288,
    expectedSampleCount: 288,
    status: 'ready',
    p25: '72',
    p75: '216',
  });
  assert.equal(result.windows['7d'].status, 'collecting');
  assert.equal(result.windows['7d'].p25, null);
});

test('zero fees and integers larger than Number can represent retain their precision', () => {
  const zero = summarizeHistory(
    history(288, now, () => 0n),
    now,
  );
  const base = 2n ** 100n;
  const large = summarizeHistory(
    history(288, now, index => base + BigInt(index)),
    now,
  );

  assert.equal(zero.windows['24h'].p25, '0');
  assert.equal(zero.windows['24h'].p75, '0');
  assert.equal(large.windows['24h'].p25, (base + 71n).toString());
  assert.equal(large.windows['24h'].p75, (base + 215n).toString());
});

test('empty, short, or insufficiently covered windows do not acquire a level', () => {
  for (const samples of [
    [],
    history(100),
    history(288).filter((_, i) => i % 2),
  ]) {
    const result = summarizeHistory(samples, now);
    assert.equal(result.windows['24h'].status, 'collecting');
    assert.equal(result.windows['24h'].p25, null);
  }
});

test('occasional missed samples at the edge or middle are tolerated', () => {
  const samples = history(288).filter((_, i) => i !== 0 && i % 40 !== 20);
  assert.equal(summarizeHistory(samples, now).windows['24h'].status, 'ready');
});

test('windows advance when collection stops and preserve the actual last update time', () => {
  const result = summarizeHistory(history(288), now + DAY_SECONDS);

  assert.equal(result.updatedAt, now);
  assert.equal(result.windows['24h'].from, now);
  assert.equal(result.windows['24h'].sampleCount, 0);
  assert.equal(result.windows['24h'].status, 'collecting');
});

test('same-bucket sampling replaces a point and drops data outside seven days', () => {
  const previous = history(2016);
  const replacement = {
    ...previous.at(-1),
    blockNumber: '3000',
    baseFeePerGas: '42',
  };
  const replaced = addSample(previous, replacement);

  assert.equal(replaced.length, 2016);
  assert.equal(replaced.at(-1).baseFeePerGas, '42');
  const appended = addSample(replaced, {
    ...replacement,
    timestamp: now + INTERVAL,
  });
  assert.equal(appended.length, 2016);
  assert.ok(
    appended.every(sample => sample.timestamp > now + INTERVAL - WEEK_SECONDS),
  );
  assert.equal(
    summarizeHistory(appended, now + INTERVAL).windows['7d'].status,
    'ready',
  );
});
