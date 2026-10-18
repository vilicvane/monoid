import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';

import {base58} from '@scure/base';

const {parseSolanaIdl, decodeSolanaIdlInstruction} = await import(
  '../.bld/app/@lib/solana-idl.js'
);
const programAddress = base58.encode(new Uint8Array(32).fill(7));
const accountAddress = base58.encode(new Uint8Array(32).fill(8));
const otherProgram = base58.encode(new Uint8Array(32).fill(9));

function modern(args = [], types = [], options = {}) {
  return {
    address: programAddress,
    metadata: {name: 'example', version: '1.0.0', spec: '0.1.0'},
    instructions: [
      {
        name: 'inspect',
        discriminator: [17, 23],
        accounts: [],
        args,
        ...options,
      },
    ],
    types,
  };
}

function field(name, type, value) {
  return {name, type, kind: 'value', value};
}

function wire(...parts) {
  return Uint8Array.from(
    parts.flatMap(part => (typeof part === 'number' ? [part] : [...part])),
  );
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

function decode(source, bytes, accounts = []) {
  const idl = parseSolanaIdl(source, programAddress);
  assert.ok(idl, 'fixture IDL must parse');
  return decodeSolanaIdlInstruction(idl, {
    programAddress,
    data: bytes,
    accounts,
  });
}

test('decodes modern variable-length discriminators and exact large integers', () => {
  const source = modern([
    {name: 'chain_id', type: 'u64'},
    {name: 'debt', type: 'i128'},
  ]);
  const result = decode(
    source,
    wire([17, 23], u64(2n ** 64n - 1n), new Uint8Array(16).fill(255)),
  );
  assert.equal(result.name, 'inspect');
  assert.equal(result.programName, 'example');
  assert.equal(result.version, '1.0.0');
  assert.deepEqual(result.fields, [
    field('chainId', 'u64', '18446744073709551615'),
    field('debt', 'i128', '-1'),
  ]);
});

test('decodes nested structs, arrays, enums, options, public keys, and raw bytes', () => {
  const source = modern(
    [
      {name: 'owner', type: 'pubkey'},
      {name: 'label', type: 'string'},
      {name: 'enabled', type: 'bool'},
      {name: 'data', type: 'bytes'},
      {name: 'config', type: {defined: {name: 'Config'}}},
    ],
    [
      {
        name: 'Config',
        type: {
          kind: 'struct',
          fields: [
            {name: 'counts', type: {array: ['u16', 2]}},
            {name: 'choice', type: {option: {option: 'u8'}}},
            {name: 'mode', type: {defined: {name: 'Mode'}}},
          ],
        },
      },
      {
        name: 'Mode',
        type: {
          kind: 'enum',
          variants: [
            {name: 'Off'},
            {name: 'Pair', fields: ['i16', 'pubkey']},
            {name: 'Named', fields: [{name: 'limit', type: 'u64'}]},
          ],
        },
      },
    ],
  );
  const result = decode(
    source,
    wire(
      [17, 23],
      new Uint8Array(32).fill(8),
      u32(2),
      [104, 105],
      1,
      u32(3),
      [0, 127, 255],
      [1, 0, 2, 0],
      [1, 0],
      2,
      u64(42n),
    ),
  );
  assert.deepEqual(result.fields.slice(0, 4), [
    field('owner', 'pubkey', accountAddress),
    field('label', 'string', 'hi'),
    field('enabled', 'bool', true),
    field('data', 'bytes', '0x007fff'),
  ]);
  assert.deepEqual(result.fields[4], {
    name: 'config',
    type: 'struct',
    kind: 'struct',
    children: [
      {
        name: 'counts',
        type: 'array',
        kind: 'array',
        children: [field('[0]', 'u16', '1'), field('[1]', 'u16', '2')],
      },
      {
        name: 'choice',
        type: 'option',
        kind: 'struct',
        children: [field('Some', 'option', 'None')],
      },
      {
        name: 'mode',
        type: 'enum',
        kind: 'struct',
        children: [
          {
            name: 'named',
            type: 'struct',
            kind: 'struct',
            children: [field('limit', 'u64', '42')],
          },
        ],
      },
    ],
  });
});

test('keeps enum variants, tuple values, and named fields without collisions', () => {
  const source = modern(
    [{name: 'mode', type: {defined: {name: 'Mode'}}}],
    [
      {
        name: 'Mode',
        type: {
          kind: 'enum',
          variants: [
            {name: 'Empty'},
            {name: 'Pair', fields: ['u8', 'bool']},
            {name: 'Named', fields: [{name: 'fields', type: {vec: 'u8'}}]},
          ],
        },
      },
    ],
  );
  assert.deepEqual(decode(source, wire([17, 23], 0)).fields, [
    field('mode', 'enum', 'empty'),
  ]);
  assert.deepEqual(
    decode(source, wire([17, 23], [1, 42, 1])).fields[0].children[0].children,
    [field('[0]', 'u8', '42'), field('[1]', 'bool', true)],
  );
  assert.deepEqual(
    decode(source, wire([17, 23], 2, u32(1), 42)).fields[0].children[0]
      .children[0].children,
    [field('[0]', 'u8', '42')],
  );
});

test('supports legacy Anchor IDLs without requiring an embedded address', () => {
  const source = {
    name: 'example',
    version: '0.1.0',
    instructions: [
      {
        name: 'initialize',
        accounts: [],
        args: [
          {name: 'owner', type: 'publicKey'},
          {name: 'amount', type: {defined: 'Amount'}},
        ],
      },
    ],
    types: [
      {
        name: 'Amount',
        type: {kind: 'struct', fields: [{name: 'value', type: 'u64'}]},
      },
    ],
  };
  const discriminator = [175, 175, 109, 31, 13, 152, 155, 237];
  const result = decode(
    source,
    wire(discriminator, new Uint8Array(32).fill(8), u64(42n)),
  );
  assert.equal(result.name, 'initialize');
  assert.deepEqual(result.fields[1].children, [field('value', 'u64', '42')]);
});

test('flattens account groups, preserves transaction privileges, and leaves remaining accounts unnamed', () => {
  const source = modern([], [], {
    accounts: [
      {
        name: 'group',
        accounts: [
          {name: 'authority', signer: true},
          {name: 'optional_mint', optional: true},
        ],
      },
    ],
  });
  const accounts = [
    {address: accountAddress, isSigner: true, isWritable: true},
    {address: programAddress, isSigner: false, isWritable: false},
    {address: otherProgram, isSigner: false, isWritable: true},
  ];
  const before = structuredClone(accounts);
  const result = decode(source, wire([17, 23]), accounts);
  assert.deepEqual(result.accountNames, [
    'authority',
    'optionalMint',
    undefined,
  ]);
  assert.deepEqual(accounts, before);
  assert.equal(decode(source, wire([17, 23]), accounts.slice(0, 1)), undefined);
});

test('does not guess positions when legacy optional accounts can be omitted', () => {
  const source = {
    name: 'example',
    version: '0.1.0',
    instructions: [
      {
        name: 'inspect',
        legacyOptionalAccountsStrategy: true,
        args: [],
        accounts: [{name: 'payer', isOptional: true}, {name: 'owner'}],
      },
    ],
  };
  const discriminator = createHash('sha256')
    .update('global:inspect')
    .digest()
    .subarray(0, 8);
  assert.equal(
    decode(source, discriminator, [
      {address: accountAddress},
      {address: otherProgram},
    ]),
    undefined,
  );
});

test('binds the program and rejects wrong network-program metadata or unsupported IDL dialects', () => {
  const source = modern();
  assert.equal(parseSolanaIdl(source, otherProgram), undefined);
  assert.equal(
    parseSolanaIdl(
      {...source, metadata: {...source.metadata, address: otherProgram}},
      programAddress,
    ),
    undefined,
  );
  assert.equal(
    parseSolanaIdl(
      {...source, metadata: {...source.metadata, spec: '9.0.0'}},
      programAddress,
    ),
    undefined,
  );
  assert.equal(
    parseSolanaIdl(
      {...source, metadata: {...source.metadata, origin: 'shank'}},
      programAddress,
    ),
    undefined,
  );
  assert.equal(parseSolanaIdl(source, 'not-an-address'), undefined);
  assert.equal(
    decodeSolanaIdlInstruction(parseSolanaIdl(source, programAddress), {
      programAddress: otherProgram,
      accounts: [],
      data: wire([17, 23]),
    }),
    undefined,
  );
});

test('rejects ambiguous or invalid discriminators', () => {
  for (const discriminator of [
    [17, 23],
    [17],
    [17, 23, 25],
    [],
    [256],
    [-1],
    [0.5],
  ]) {
    const source = modern();
    source.instructions.push({
      ...source.instructions[0],
      name: 'other',
      discriminator,
    });
    assert.equal(parseSolanaIdl(source, programAddress), undefined);
  }
});

test('requires complete canonical bytes, including vector and string prefixes', () => {
  const source = modern([{name: 'values', type: {vec: 'u8'}}]);
  for (const bytes of [
    wire([17, 23]),
    wire([17, 23], u32(2), 1),
    wire([17, 23], u32(0), 0),
    wire([17, 23], u32(0xffffffff)),
  ]) {
    assert.equal(decode(source, bytes), undefined);
  }
  assert.deepEqual(
    decode(source, wire([17, 23], u32(0))).fields[0].children,
    [],
  );
  assert.equal(
    decode(modern([{name: 'flag', type: 'bool'}]), wire([17, 23], 2)),
    undefined,
  );
  assert.equal(
    decode(
      modern([{name: 'text', type: 'string'}]),
      wire([17, 23], u32(1), 255),
    ),
    undefined,
  );
});

test('bounds schema and data while isolating unsupported unrelated instructions', () => {
  const source = modern(
    [{name: 'amount', type: 'u64'}],
    [
      {
        name: 'Opaque',
        serialization: {custom: 'external'},
        type: {kind: 'struct', fields: []},
      },
    ],
  );
  source.instructions.push({
    name: 'unsupported',
    discriminator: [99],
    accounts: [],
    args: [{name: 'opaque', type: {defined: {name: 'Opaque'}}}],
  });
  assert.deepEqual(decode(source, wire([17, 23], u64(42n))).fields, [
    field('amount', 'u64', '42'),
  ]);
  assert.equal(decode(source, wire(99)), undefined);
  assert.equal(decode(source, new Uint8Array(16_385)), undefined);
  assert.equal(
    parseSolanaIdl({...source, docs: ['x'.repeat(1_000_001)]}, programAddress),
    undefined,
  );
  const recursive = modern(
    [{name: 'value', type: {defined: {name: 'Recursive'}}}],
    [
      {
        name: 'Recursive',
        type: {
          kind: 'struct',
          fields: [
            {name: 'next', type: {option: {defined: {name: 'Recursive'}}}},
          ],
        },
      },
    ],
  );
  assert.equal(decode(recursive, wire([17, 23], 0)), undefined);
});

test('rejects duplicate normalized field names and zero-width vector elements', () => {
  assert.equal(
    decode(
      modern([
        {name: 'some_value', type: 'u8'},
        {name: 'someValue', type: 'u8'},
      ]),
      wire([17, 23], [1, 2]),
    ),
    undefined,
  );
  const source = modern(
    [{name: 'values', type: {vec: {defined: {name: 'Empty'}}}}],
    [{name: 'Empty', type: {kind: 'struct', fields: []}}],
  );
  assert.equal(decode(source, wire([17, 23], u32(0xffffffff))), undefined);
  assert.equal(
    parseSolanaIdl(modern([{name: '__proto__', type: 'u8'}]), programAddress),
    undefined,
  );
});

test('does not impose the Anchor instruction encoder 1000-byte buffer limit', () => {
  const bytes = new Uint8Array(1200).fill(42);
  const result = decode(
    modern([{name: 'bytes', type: 'bytes'}]),
    wire([17, 23], u32(bytes.length), bytes),
  );
  assert.equal(result.fields[0].value, `0x${'2a'.repeat(1200)}`);
});

test('rejects missing nested vector prefixes before processing unbounded counts', () => {
  const source = modern([{name: 'values', type: {vec: {vec: 'u8'}}}]);
  for (const size of [1, 1000, 0xffffffff]) {
    assert.equal(decode(source, wire([17, 23], u32(size))), undefined);
  }
  assert.deepEqual(
    decode(source, wire([17, 23], u32(1), u32(0))).fields[0].children[0]
      .children,
    [],
  );
});

test('rejects type names that normalize to the same Codama name', () => {
  const source = modern(
    [
      {name: 'a', type: {defined: {name: 'FooBar'}}},
      {name: 'b', type: {defined: {name: 'foo_bar'}}},
    ],
    [
      {
        name: 'FooBar',
        type: {kind: 'struct', fields: [{name: 'first', type: 'u8'}]},
      },
      {
        name: 'foo_bar',
        type: {kind: 'struct', fields: [{name: 'second', type: 'u8'}]},
      },
    ],
  );
  assert.equal(decode(source, wire([17, 23], [4, 9])), undefined);
  assert.equal(
    decode(modern([{name: 'discriminator', type: 'u8'}]), wire([17, 23], 42)),
    undefined,
  );
});

test('bounds nested decoding work before building many zero-byte structures', () => {
  const source = modern(
    [{name: 'items', type: {vec: {defined: {name: 'Item'}}}}],
    [
      {name: 'Empty', type: {kind: 'struct', fields: []}},
      {
        name: 'Item',
        type: {
          kind: 'struct',
          fields: [
            {name: 'value', type: 'u8'},
            ...Array.from({length: 200}, (_, index) => ({
              name: `empty_${index}`,
              type: {defined: {name: 'Empty'}},
            })),
          ],
        },
      },
    ],
  );
  assert.equal(
    decode(source, wire([17, 23], u32(1000), new Uint8Array(1000))),
    undefined,
  );
});
