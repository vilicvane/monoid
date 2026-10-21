import assert from 'node:assert/strict';
import {test} from 'node:test';

import {decode, encode} from 'cbor2';
import * as x from 'x-value';

import {XUint8Array, xCBOR} from '../.bld/app/@x-value/index.js';

test('CBOR schema encoding omits optional fields in nested objects and arrays', () => {
  const schema = x.object({
    omitted: x.string.optional(),
    nested: x.object({
      omitted: x.string.optional(),
      items: x.array(
        x.object({
          value: x.number,
          omitted: x.string.optional(),
          details: x.object({label: x.string.optional()}).optional(),
        }),
      ),
    }),
  });
  const input = {
    nested: {
      items: [
        {value: 1, omitted: undefined, details: {}},
        {value: 2, details: {label: 'present'}},
      ],
    },
  };
  const before = structuredClone(input);

  assert.deepEqual(decode(schema.encode(xCBOR, input)), {
    nested: {
      items: [
        {value: 1, details: {}},
        {value: 2, details: {label: 'present'}},
      ],
    },
  });
  assert.deepEqual(input, before);
});

test('CBOR encoding preserves schema field order, false, null and zero', () => {
  const schema = x.object({
    longerName: x.number,
    a: x.boolean,
    nested: x.object({longerName: x.null, a: x.number}),
  });
  const input = Object.freeze({
    nested: Object.freeze({a: 0, longerName: null}),
    a: false,
    longerName: 0,
  });
  const expected = {
    longerName: 0,
    a: false,
    nested: {longerName: null, a: 0},
  };
  const packed = schema.encode(xCBOR, input);

  assert.deepEqual(packed, encode(expected, {sortKeys: null}));
  assert.deepEqual(decode(packed), expected);
  assert.deepEqual(Object.keys(input), ['nested', 'a', 'longerName']);
  assert.deepEqual(Object.keys(input.nested), ['a', 'longerName']);
});

test('CBOR packing retains array positions while omitting undefined object properties', () => {
  const entry = Object.freeze(
    Object.assign(Object.create(null), {
      omitted: undefined,
      value: 0,
    }),
  );
  const input = Object.freeze([false, entry, null, 0, [entry, '']]);

  assert.deepEqual(decode(x.unknown.encode(xCBOR, input)), [
    false,
    {value: 0},
    null,
    0,
    [{value: 0}, ''],
  ]);
  assert.equal(input[1], entry);
  assert.equal(input[4][0], entry);
  assert.ok(Object.hasOwn(entry, 'omitted'));
});

test('CBOR encoding retains byte strings in fields and array entries', () => {
  const binary = new Uint8Array([0, 1, 127, 128, 255]);
  const schema = x.object({
    binary: XUint8Array,
    items: x.array(
      x.object({binary: XUint8Array, omitted: x.string.optional()}),
    ),
  });
  const input = {binary, items: [{binary}]};
  const decoded = decode(schema.encode(xCBOR, input));

  assert.ok(decoded.binary instanceof Uint8Array);
  assert.ok(decoded.items[0].binary instanceof Uint8Array);
  assert.deepEqual(decoded, input);
  assert.equal(input.binary, binary);
  assert.equal(input.items[0].binary, binary);
  assert.deepEqual(binary, new Uint8Array([0, 1, 127, 128, 255]));
});

test('CBOR packing leaves non-plain objects available to their encoder', () => {
  let encoded;

  class CustomValue {
    toCBOR() {
      encoded = this;
      return [undefined, 'custom'];
    }
  }

  const value = new CustomValue();

  assert.deepEqual(decode(x.unknown.encode(xCBOR, {value})), {value: 'custom'});
  assert.equal(encoded, value);
});

test('CBOR encoding rejects undefined array entries instead of removing them', () => {
  const sparse = new Array(2);
  sparse[1] = 1;
  for (const input of [
    [undefined, 1],
    [1, undefined],
    [1, [undefined]],
    sparse,
  ]) {
    const before = structuredClone(input);

    assert.throws(() => x.unknown.encode(xCBOR, input), /undefined/);
    assert.deepEqual(input, before);
  }
});
