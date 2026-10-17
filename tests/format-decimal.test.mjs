import assert from 'node:assert/strict';
import {test} from 'node:test';

const {formatDecimal} = await import('../.bld/app/@lib/format-decimal.js');

test('preserves exact values and removes insignificant fractional zeros', () => {
  for (const [input, value] of [
    ['0', '0'],
    ['0.0', '0'],
    ['0.000000', '0'],
    ['-0.000', '0'],
    ['1', '1'],
    ['1.230000', '1.23'],
    ['1234.00000', '1234'],
    ['0.00063', '0.00063'],
    ['0.000000001', '0.000000001'],
    ['0.000001230000', '0.00000123'],
    [
      '1000000000000000000000000000000000000',
      '1000000000000000000000000000000000000',
    ],
  ]) {
    assert.deepEqual(formatDecimal(input), {value, approximate: false}, input);
  }
});

test('rounds to four significant digits without floating-point conversion', () => {
  for (const [input, value] of [
    ['1.2344', '1.234'],
    ['1.2345', '1.235'],
    ['0.0000012345678901234567890123456789', '0.000001235'],
    ['123456789012345678901234567890', '123500000000000000000000000000'],
    ['9007199254740993', '9007000000000000'],
    ['9999.4', '9999'],
    ['9999.5', '10000'],
    ['9.9995', '10'],
    ['0.99995', '1'],
    ['0.000099995', '0.0001'],
    ['-1.2344', '-1.234'],
    ['-1.2345', '-1.235'],
    ['-0.000099995', '-0.0001'],
  ]) {
    assert.deepEqual(formatDecimal(input), {value, approximate: true}, input);
  }
});

test('marks approximation only when discarded digits change the value', () => {
  assert.deepEqual(formatDecimal('123400000000000000000000000000'), {
    value: '123400000000000000000000000000',
    approximate: false,
  });
  assert.deepEqual(formatDecimal('123400000000000000000000000001'), {
    value: '123400000000000000000000000000',
    approximate: true,
  });
  assert.deepEqual(formatDecimal('1.23400000000000000000000000001'), {
    value: '1.234',
    approximate: true,
  });
});

test('supports an explicit significant-digit count and large exact integers', () => {
  assert.deepEqual(formatDecimal('9.5', 1), {value: '10', approximate: true});
  assert.deepEqual(formatDecimal('0.001234', 2), {
    value: '0.0012',
    approximate: true,
  });
  assert.deepEqual(formatDecimal('9007199254740993', 16), {
    value: '9007199254740993',
    approximate: false,
  });
  assert.deepEqual(formatDecimal('999999999999999999995', 20), {
    value: '1000000000000000000000',
    approximate: true,
  });
});
