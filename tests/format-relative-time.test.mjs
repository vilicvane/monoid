import assert from 'node:assert/strict';
import {test} from 'node:test';

import {formatRelativeTime} from '../.bld/app/@lib/format-relative-time.js';

test('formats relative time in the UI language at unit boundaries without rounding up', () => {
  const now = Date.UTC(2026, 9, 17, 12);

  for (const [elapsed, expected] of [
    [0, 'now'],
    [59_999, 'now'],
    [60_000, '1 minute ago'],
    [3_599_999, '59 minutes ago'],
    [3_600_000, '1 hour ago'],
    [86_400_000, 'yesterday'],
    [604_800_000, 'last week'],
    [2_592_000_000, 'last month'],
    [31_536_000_000, 'last year'],
    [-120_000, 'in 2 minutes'],
  ]) {
    assert.equal(formatRelativeTime(now - elapsed, now), expected);
  }
});
