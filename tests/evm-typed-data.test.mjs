import assert from 'node:assert/strict';
import {test} from 'node:test';

import {TypedDataEncoder} from 'ethers';

const {parseEvmTypedData} = await import('../.bld/app/@lib/evm-typed-data.js');

function mail() {
  return {
    types: {
      EIP712Domain: [
        {name: 'name', type: 'string'},
        {name: 'version', type: 'string'},
        {name: 'chainId', type: 'uint256'},
        {name: 'verifyingContract', type: 'address'},
      ],
      Person: [
        {name: 'name', type: 'string'},
        {name: 'wallet', type: 'address'},
      ],
      Mail: [
        {name: 'from', type: 'Person'},
        {name: 'to', type: 'Person'},
        {name: 'contents', type: 'string'},
      ],
    },
    primaryType: 'Mail',
    domain: {
      name: 'Ether Mail',
      version: '1',
      chainId: 1,
      verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
    },
    message: {
      from: {
        name: 'Cow',
        wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826',
      },
      to: {
        name: 'Bob',
        wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB',
      },
      contents: 'Hello, Bob!',
    },
  };
}

test('matches the official EIP-712 Mail digest for both JSON and object payloads', () => {
  const input = mail();
  const original = structuredClone(input);

  for (const value of [input, JSON.stringify(input)]) {
    const {data, digest} = parseEvmTypedData(value);
    assert.equal(
      digest,
      '0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2',
    );
    assert.equal(data.primaryType, 'Mail');
    assert.equal(data.message.contents, 'Hello, Bob!');
    assert.equal(
      data.message.from.wallet,
      input.message.from.wallet.toLowerCase(),
    );
  }
  assert.deepEqual(input, original);
});

test('normalizes nested arrays and exact large integers without changing signed values', () => {
  const maximum = (2n ** 256n - 1n).toString();
  const input = {
    domain: {},
    types: {
      EIP712Domain: [],
      Permission: [
        {name: 'account', type: 'address'},
        {name: 'amount', type: 'uint256'},
        {name: 'enabled', type: 'bool'},
      ],
      Batch: [
        {name: 'permissions', type: 'Permission[]'},
        {name: 'nonces', type: 'uint256[2]'},
        {name: 'data', type: 'bytes'},
      ],
    },
    primaryType: 'Batch',
    message: {
      permissions: [
        {
          account: mail().message.from.wallet,
          amount: maximum,
          enabled: true,
          extra: 'not signed',
        },
      ],
      nonces: ['9007199254740993', '0x20'],
      data: '0xABcd',
      extra: 'not signed',
    },
  };
  const {data, digest} = parseEvmTypedData(input);
  assert.deepEqual(data.message, {
    permissions: [
      {
        account: input.message.permissions[0].account.toLowerCase(),
        amount: maximum,
        enabled: true,
      },
    ],
    nonces: ['9007199254740993', '32'],
    data: '0xabcd',
  });
  assert.equal(parseEvmTypedData(data).digest, digest);

  input.message.permissions[0].amount = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => parseEvmTypedData(input));
});

test('hashes the declared domain field order instead of silently sorting it', () => {
  const input = {
    domain: {name: 'Demo', version: '1'},
    primaryType: 'Action',
    types: {
      EIP712Domain: [
        {name: 'version', type: 'string'},
        {name: 'name', type: 'string'},
      ],
      Action: [{name: 'ok', type: 'bool'}],
    },
    message: {ok: true},
  };
  const {data, digest} = parseEvmTypedData(input);
  assert.deepEqual(data.types.EIP712Domain, input.types.EIP712Domain);
  assert.equal(
    digest,
    '0x581d028e5de7ae1813300d47f098ee20485decbf7052372d5e59dbc11cf136d5',
  );
  assert.notEqual(
    digest,
    TypedDataEncoder.hash(
      input.domain,
      {Action: input.types.Action},
      input.message,
    ),
  );
});

test('rejects missing, null, duplicate, extra or mistyped domain declarations', () => {
  for (const change of [
    input => delete input.types.EIP712Domain,
    input => input.types.EIP712Domain.pop(),
    input => input.types.EIP712Domain.push(input.types.EIP712Domain[0]),
    input => (input.types.EIP712Domain[2].type = 'string'),
    input => (input.domain.version = null),
    input => (input.domain.unknown = 'extra'),
    input => delete input.domain.version,
  ]) {
    const input = mail();
    change(input);
    assert.throws(() => parseEvmTypedData(input));
  }
});

test('rejects a changed primary type, unknown references and missing message fields', () => {
  for (const change of [
    input => (input.primaryType = 'Person'),
    input => (input.types.Mail[0].type = 'Unknown'),
    input => delete input.message.from,
    input => (input.message.to.wallet = 'example.eth'),
    input => (input.types.Person[0].type = 'Person'),
  ]) {
    const input = mail();
    change(input);
    assert.throws(() => parseEvmTypedData(input));
  }
});

test('rejects integer aliases instead of changing their signed type names', () => {
  for (const type of ['uint', 'int', 'uint[]', 'int[2]']) {
    assert.throws(
      () =>
        parseEvmTypedData({
          domain: {},
          types: {EIP712Domain: [], Counter: [{name: 'value', type}]},
          primaryType: 'Counter',
          message: {value: 1},
        }),
      /bit width/,
    );
  }
});

test('rejects non-boolean values in nested structs and arrays before ethers can coerce them', () => {
  for (const value of ['false', 'true', 0, 1, null]) {
    assert.throws(
      () =>
        parseEvmTypedData({
          domain: {},
          types: {
            EIP712Domain: [],
            Flags: [{name: 'values', type: 'bool[]'}],
            Request: [{name: 'flags', type: 'Flags'}],
          },
          primaryType: 'Request',
          message: {flags: {values: [true, value]}},
        }),
      /boolean/,
    );
  }
});

test('rejects malformed payload and type shapes', () => {
  for (const input of [
    undefined,
    null,
    [],
    '{',
    'null',
    {...mail(), domain: []},
    {...mail(), message: null},
    {...mail(), types: {EIP712Domain: [], Mail: null}},
    {...mail(), types: {EIP712Domain: [], Mail: [null]}},
  ]) {
    assert.throws(() => parseEvmTypedData(input));
  }
});

test('rejects prototype-named types and fields instead of hiding signed data during normalization', () => {
  for (const input of [
    JSON.parse(`{
      "domain": {},
      "types": {
        "EIP712Domain": [],
        "Hidden": [{"name": "amount", "type": "uint256"}],
        "Request": [{"name": "__proto__", "type": "Hidden"}]
      },
      "primaryType": "Request",
      "message": {"__proto__": {"amount": "100"}}
    }`),
    JSON.parse(`{
      "domain": {},
      "types": {
        "EIP712Domain": [],
        "__proto__": [{"name": "amount", "type": "uint256"}]
      },
      "primaryType": "__proto__",
      "message": {"amount": "100"}
    }`),
  ]) {
    assert.throws(() => parseEvmTypedData(input));
  }
});
