import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {decode} from 'cbor2';
import * as x from 'x-value';

import {monoidCommandDefinitions} from '../.bld/app/@lib/monoid/monoid-applet.js';
import {XUint8Array, xCBOR} from '../.bld/app/@x-value/index.js';

const fieldOrders = JSON.parse(
  readFileSync(
    new URL('../../monoid-javacard/cbor-field-order.json', import.meta.url),
    'utf8',
  ),
);

const index = new Uint8Array(10);
const path = new Uint8Array([0x80, 0, 0, 0x2c]);
const digest = new Uint8Array(32);
const context = new TextEncoder().encode('example.com');
const taprootValues = [undefined, false, true, {}, {merkleRoot: digest}];

const keyFamilies = [
  {type: 'secp256k1', derivation: {type: 'bip32', path}, cipher: 'ecdsa'},
  {
    type: 'ed25519',
    derivation: {type: 'slip10', curve: 'ed25519', path},
    cipher: 'ed25519',
  },
  {
    type: 'secp256r1',
    derivation: {type: 'monoid-001', context},
    cipher: 'ecdsa',
  },
];

const fixtures = {
  hello: [{}],
  authenticate: [{pin: '123456'}, {safe: true, pin: '123456'}],
  setPIN: [{pin: '123456'}, {pin: '123456', safe: true}],
  list: [{}, {type: 'seed', keyPrefix: context}, {type: 0x1001}],
  set: [
    {index, alias: 'Main'},
    {index, data: context},
    {index, alias: 'Main', data: context},
  ],
  viewKey: [],
  sign: [],
};

for (const {type, derivation, cipher} of keyFamilies) {
  const keys = [
    {index, type},
    {index, type: 'seed', derivation},
    {index, type: 'master', derivation},
  ];

  for (const key of keys) {
    fixtures.sign.push({
      ...key,
      cipher,
      ...(cipher === 'ed25519' ? {message: context} : {digest}),
    });

    if (type !== 'secp256k1') {
      fixtures.viewKey.push(key);
      continue;
    }

    for (const taproot of taprootValues) {
      const options = taproot === undefined ? {} : {taproot};

      fixtures.viewKey.push({...key, ...options});
      fixtures.sign.push({...key, cipher: 'bip340', ...options, digest});
    }
  }
}

function isMap(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function reverseFields(value) {
  if (!isMap(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseFields(child)]),
  );
}

function assertEncodedOrder(ins, schema, request) {
  const command = `0x${ins.toString(16).padStart(2, '0').toUpperCase()}`;
  const configured = fieldOrders[command];

  assert.ok(configured, `Missing firmware field order for INS ${command}.`);

  const encoded = decode(schema.encode(xCBOR, request));

  assert.deepEqual(encoded, request, `INS ${command}: request fields changed.`);

  for (const [path, order] of Object.entries(configured)) {
    const value = path
      .split('.')
      .slice(1)
      .reduce((value, key) => value?.[key], encoded);

    if (!isMap(value)) {
      continue;
    }

    const actual = Object.keys(value);
    const expected = [
      ...order.filter(key => Object.hasOwn(value, key)),
      ...actual.filter(key => !order.includes(key)),
    ];

    assert.deepEqual(
      actual,
      expected,
      `INS ${command}, ${path}: encoded [${actual.join(', ')}], expected [${expected.join(', ')}].`,
    );
  }
}

test('field-order fixtures cover every command exposed by the APP', () => {
  assert.deepEqual(
    Object.keys(fixtures).sort(),
    Object.keys(monoidCommandDefinitions).sort(),
  );
});

for (const [name, requests] of Object.entries(fixtures)) {
  test(`${name} encodes all request branches in firmware-recommended order`, () => {
    const {ins, request: schema} = monoidCommandDefinitions[name];

    for (const request of requests) {
      assertEncodedOrder(ins, schema, reverseFields(request));
    }
  });
}

test('the assertion detects an Authenticate schema with pin before safe', () => {
  const wrongOrder = x.object({pin: x.string, safe: x.literal(true)});

  assert.throws(
    () => assertEncodedOrder(0x21, wrongOrder, {safe: true, pin: '123456'}),
    error => {
      assert.match(error.message, /INS 0x21, \$/);
      assert.deepEqual(error.actual, ['pin', 'safe']);
      assert.deepEqual(error.expected, ['safe', 'pin']);

      return true;
    },
  );
});

test('the assertion detects BIP340 intersection members placing taproot before cipher', () => {
  const wrongOrder = x.intersection([
    x.object({index: XUint8Array, type: x.literal('secp256k1')}),
    x.object({taproot: x.boolean}),
    x.object({cipher: x.literal('bip340'), digest: XUint8Array}),
  ]);

  assert.throws(
    () =>
      assertEncodedOrder(0x41, wrongOrder, {
        index,
        type: 'secp256k1',
        cipher: 'bip340',
        taproot: true,
        digest,
      }),
    error => {
      assert.match(error.message, /INS 0x41, \$/);
      assert.deepEqual(error.actual, [
        'index',
        'type',
        'taproot',
        'cipher',
        'digest',
      ]);
      assert.deepEqual(error.expected, [
        'index',
        'type',
        'cipher',
        'taproot',
        'digest',
      ]);

      return true;
    },
  );
});
