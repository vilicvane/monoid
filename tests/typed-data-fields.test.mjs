import assert from 'node:assert/strict';
import {test} from 'node:test';

const {parseEvmTypedData} = await import('../.bld/app/@lib/evm-typed-data.js');
const {getTypedDataFields} = await import(
  '../.bld/app/@lib/typed-data-fields.js'
);

test('follows declared struct and domain order while preserving exact normalized values', () => {
  const maximum = (2n ** 256n - 1n).toString();
  const {data} = parseEvmTypedData({
    domain: {name: 'Demo', version: '1'},
    primaryType: 'Permission',
    types: {
      EIP712Domain: [
        {name: 'version', type: 'string'},
        {name: 'name', type: 'string'},
      ],
      Account: [
        {name: 'address', type: 'address'},
        {name: 'alias', type: 'string'},
      ],
      Permission: [
        {name: 'account', type: 'Account'},
        {name: 'amount', type: 'uint256'},
        {name: 'enabled', type: 'bool'},
      ],
    },
    message: {
      enabled: false,
      amount: maximum,
      account: {
        alias: '',
        address: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
      },
    },
  });
  const original = structuredClone(data);

  assert.deepEqual(
    getTypedDataFields(data.types, data.primaryType, data.message),
    [
      {
        name: 'account',
        type: 'Account',
        kind: 'struct',
        children: [
          {
            name: 'address',
            type: 'address',
            kind: 'value',
            value: '0xcccccccccccccccccccccccccccccccccccccccc',
          },
          {name: 'alias', type: 'string', kind: 'value', value: ''},
        ],
      },
      {name: 'amount', type: 'uint256', kind: 'value', value: maximum},
      {name: 'enabled', type: 'bool', kind: 'value', value: false},
    ],
  );
  assert.deepEqual(
    getTypedDataFields(data.types, 'EIP712Domain', data.domain),
    [
      {name: 'version', type: 'string', kind: 'value', value: '1'},
      {name: 'name', type: 'string', kind: 'value', value: 'Demo'},
    ],
  );
  assert.deepEqual(data, original);
});

test('retains array dimensions and indexes for nested structs and empty arrays', () => {
  const {data} = parseEvmTypedData({
    domain: {},
    primaryType: 'Batch',
    types: {
      EIP712Domain: [],
      Item: [{name: 'value', type: 'int256'}],
      Batch: [{name: 'items', type: 'Item[][2]'}],
    },
    message: {items: [[{value: '-9007199254740993'}, {value: '0'}], []]},
  });

  assert.deepEqual(
    getTypedDataFields(data.types, data.primaryType, data.message),
    [
      {
        name: 'items',
        type: 'Item[][2]',
        kind: 'array',
        children: [
          {
            name: '[0]',
            type: 'Item[]',
            kind: 'array',
            children: [
              {
                name: '[0]',
                type: 'Item',
                kind: 'struct',
                children: [
                  {
                    name: 'value',
                    type: 'int256',
                    kind: 'value',
                    value: '-9007199254740993',
                  },
                ],
              },
              {
                name: '[1]',
                type: 'Item',
                kind: 'struct',
                children: [
                  {name: 'value', type: 'int256', kind: 'value', value: '0'},
                ],
              },
            ],
          },
          {name: '[1]', type: 'Item[]', kind: 'array', children: []},
        ],
      },
    ],
  );
});

test('keeps empty structs and primitive array values distinct', () => {
  const {data} = parseEvmTypedData({
    domain: {},
    primaryType: 'Action',
    types: {
      EIP712Domain: [],
      Empty: [],
      Action: [
        {name: 'empty', type: 'Empty'},
        {name: 'flags', type: 'bool[2]'},
        {name: 'data', type: 'bytes'},
      ],
    },
    message: {empty: {}, flags: [false, true], data: '0x'},
  });

  assert.deepEqual(
    getTypedDataFields(data.types, 'EIP712Domain', data.domain),
    [],
  );
  assert.deepEqual(
    getTypedDataFields(data.types, data.primaryType, data.message),
    [
      {name: 'empty', type: 'Empty', kind: 'struct', children: []},
      {
        name: 'flags',
        type: 'bool[2]',
        kind: 'array',
        children: [
          {name: '[0]', type: 'bool', kind: 'value', value: false},
          {name: '[1]', type: 'bool', kind: 'value', value: true},
        ],
      },
      {name: 'data', type: 'bytes', kind: 'value', value: '0x'},
    ],
  );
});

test('expands arrays whose accepted struct names contain line breaks', () => {
  const {data} = parseEvmTypedData({
    domain: {},
    primaryType: 'Batch',
    types: {
      EIP712Domain: [],
      'Line\nType': [{name: 'amount', type: 'uint256'}],
      Batch: [{name: 'items', type: 'Line\nType[]'}],
    },
    message: {items: [{amount: '100'}]},
  });

  assert.deepEqual(
    getTypedDataFields(data.types, data.primaryType, data.message),
    [
      {
        name: 'items',
        type: 'Line\nType[]',
        kind: 'array',
        children: [
          {
            name: '[0]',
            type: 'Line\nType',
            kind: 'struct',
            children: [
              {name: 'amount', type: 'uint256', kind: 'value', value: '100'},
            ],
          },
        ],
      },
    ],
  );
});
