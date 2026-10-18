import assert from 'node:assert/strict';
import {createPrivateKey, createPublicKey, sign, verify} from 'node:crypto';
import {test} from 'node:test';

import {base58} from '@scure/base';

import {
  addSolanaTransactionSignature,
  parseSolanaTransaction,
} from '../.bld/app/@lib/solana-transaction.js';

function signingKey(byte) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, byte),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey);
  const bytes = publicKey.export({format: 'der', type: 'spki'}).subarray(-32);

  return {privateKey, publicKey, bytes, address: base58.encode(bytes)};
}

const payer = signingKey(1);
const cosigner = signingKey(2);
const recipient = signingKey(3);
const systemProgram = new Uint8Array(32);
const blockhash = new Uint8Array(32).fill(4);
const lookupTable = new Uint8Array(32).fill(5);
const transferData = [2, 0, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0];

function shortVector(length) {
  const bytes = [];

  do {
    const part = length & 0x7f;
    length >>= 7;
    bytes.push(length ? part | 0x80 : part);
  } while (length);

  return bytes;
}

// Assemble wire data independently of the Solana SDK codecs under test.
function message({
  version = 'legacy',
  header = [1, 0, 1],
  accounts = [payer.bytes, recipient.bytes, systemProgram],
  instructions = [{program: 2, accounts: [0, 1], data: transferData}],
  lookups = [],
} = {}) {
  return Uint8Array.from([
    ...(version === 'legacy' ? [] : [0x80 | version]),
    ...header,
    ...shortVector(accounts.length),
    ...accounts.flatMap(account => [...account]),
    ...blockhash,
    ...shortVector(instructions.length),
    ...instructions.flatMap(instruction => [
      instruction.program,
      ...shortVector(instruction.accounts.length),
      ...instruction.accounts,
      ...shortVector(instruction.data.length),
      ...instruction.data,
    ]),
    ...(version === 'legacy'
      ? []
      : [
          ...shortVector(lookups.length),
          ...lookups.flatMap(lookup => [
            ...lookup.address,
            ...shortVector(lookup.writable.length),
            ...lookup.writable,
            ...shortVector(lookup.readonly.length),
            ...lookup.readonly,
          ]),
        ]),
  ]);
}

function wire(messageBytes, signatures = [new Uint8Array(64)]) {
  return Uint8Array.from([
    ...shortVector(signatures.length),
    ...signatures.flatMap(signature => [...signature]),
    ...messageBytes,
  ]);
}

function encode(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function signature(messageBytes, key = payer) {
  return sign(null, messageBytes, key.privateKey);
}

test('parses legacy and v0 SOL transfers without changing the signed bytes', () => {
  for (const version of ['legacy', 0]) {
    const messageBytes = message({version});
    const bytes = wire(messageBytes);
    const transaction = parseSolanaTransaction(encode(bytes));

    assert.deepEqual(transaction.bytes, bytes);
    assert.deepEqual(transaction.messageBytes, messageBytes);
    assert.equal(transaction.messageOffset, 65);
    assert.equal(transaction.compiled.version, version);
    assert.equal(transaction.compiled.lifetimeToken, base58.encode(blockhash));
    assert.deepEqual(transaction.signerAddresses, [payer.address]);
    assert.equal(transaction.feePayer, payer.address);
    assert.deepEqual(transaction.signatures, [new Uint8Array(64)]);
    assert.deepEqual(
      transaction.compiled.instructions[0].data,
      Uint8Array.from(transferData),
    );
  }
});

test('retains unresolved writable and readonly lookup indices in v0 messages', () => {
  const messageBytes = message({
    version: 0,
    accounts: [payer.bytes, systemProgram],
    instructions: [{program: 1, accounts: [0, 2, 3], data: transferData}],
    lookups: [{address: lookupTable, writable: [23], readonly: [17]}],
  });
  const transaction = parseSolanaTransaction(encode(wire(messageBytes)));

  assert.deepEqual(transaction.compiled.staticAccounts, [
    payer.address,
    base58.encode(systemProgram),
  ]);
  assert.deepEqual(transaction.compiled.addressTableLookups, [
    {
      lookupTableAddress: base58.encode(lookupTable),
      writableIndexes: [23],
      readonlyIndexes: [17],
    },
  ]);
  assert.deepEqual(
    transaction.compiled.instructions[0].accountIndices,
    [0, 2, 3],
  );
  assert.deepEqual(transaction.messageBytes, messageBytes);
});

test('patches only the matching slot and preserves another signer byte for byte', () => {
  for (const version of ['legacy', 0]) {
    const messageBytes = message({
      version,
      header: [2, 0, 1],
      accounts: [payer.bytes, cosigner.bytes, systemProgram],
    });
    const payerSignature = signature(messageBytes);
    const bytes = wire(messageBytes, [payerSignature, new Uint8Array(64)]);
    const transaction = parseSolanaTransaction(encode(bytes));
    const cosignerSignature = signature(messageBytes, cosigner);
    const encoded = addSolanaTransactionSignature(
      transaction,
      cosigner.address,
      base58.encode(cosignerSignature),
    );
    const signed = Buffer.from(encoded, 'base64');
    const expected = bytes.slice();
    expected.set(cosignerSignature, 65);

    assert.deepEqual(Uint8Array.from(signed), expected);
    assert.deepEqual(transaction.bytes, bytes);
    assert.deepEqual(signed.subarray(1, 65), payerSignature);
    assert.deepEqual(Uint8Array.from(signed.subarray(129)), messageBytes);
    assert.equal(
      verify(null, messageBytes, payer.publicKey, payerSignature),
      true,
    );
    assert.equal(
      verify(null, messageBytes, cosigner.publicKey, signed.subarray(65, 129)),
      true,
    );
    assert.deepEqual(
      parseSolanaTransaction(encoded).signatures.map(value => [...value]),
      [[...payerSignature], [...cosignerSignature]],
    );
  }
});

test('signs the fee payer slot while preserving a later co-signature', () => {
  const messageBytes = message({
    header: [2, 0, 1],
    accounts: [payer.bytes, cosigner.bytes, systemProgram],
  });
  const cosignerSignature = signature(messageBytes, cosigner);
  const bytes = wire(messageBytes, [new Uint8Array(64), cosignerSignature]);
  const transaction = parseSolanaTransaction(encode(bytes));
  const result = addSolanaTransactionSignature(
    transaction,
    payer.address,
    base58.encode(signature(messageBytes)),
  );
  const signed = Buffer.from(result, 'base64');

  assert.deepEqual(signed.subarray(65, 129), cosignerSignature);
  assert.deepEqual(Uint8Array.from(signed.subarray(129)), messageBytes);
  assert.equal(
    verify(null, messageBytes, payer.publicKey, signed.subarray(1, 65)),
    true,
  );
});

test('rejects signatures for a different message, signer, or invalid byte length', () => {
  const messageBytes = message();
  const transaction = parseSolanaTransaction(encode(wire(messageBytes)));

  for (const invalid of [
    'not base58',
    base58.encode(new Uint8Array(63)),
    base58.encode(new Uint8Array(64)),
    base58.encode(signature(Uint8Array.of(1, 2, 3))),
    base58.encode(signature(messageBytes, recipient)),
  ]) {
    assert.throws(
      () => addSolanaTransactionSignature(transaction, payer.address, invalid),
      /signature is invalid/,
    );
  }

  assert.throws(
    () =>
      addSolanaTransactionSignature(
        transaction,
        recipient.address,
        base58.encode(signature(messageBytes, recipient)),
      ),
    /not a required transaction signer/,
  );
});

test('rejects existing invalid signatures instead of silently replacing them', () => {
  const messageBytes = message();

  for (const invalid of [
    new Uint8Array(64).fill(1),
    signature(messageBytes, cosigner),
    signature(Uint8Array.of(1, 2, 3)),
  ]) {
    assert.throws(
      () => parseSolanaTransaction(encode(wire(messageBytes, [invalid]))),
      /invalid signature/,
    );
  }

  const altered = messageBytes.slice();
  altered[100] ^= 1;
  assert.throws(
    () =>
      parseSolanaTransaction(encode(wire(altered, [signature(messageBytes)]))),
    /invalid signature/,
  );
});

test('rejects malformed base64, empty transactions, and noncanonical padding', () => {
  const valid = encode(wire(message()));

  for (const invalid of [
    '',
    'not base64!',
    valid + '\n',
    ' ' + valid,
    valid + '=',
    'AQ=',
    'AR==',
  ]) {
    assert.throws(() => parseSolanaTransaction(invalid), /base64/);
  }
});

test('rejects v1, unknown versions, and message-first envelopes explicitly', () => {
  for (const version of [1, 2, 127]) {
    assert.throws(
      () => parseSolanaTransaction(encode(wire(message({version})))),
      /version is not supported/,
    );
    assert.throws(
      () => parseSolanaTransaction(encode(message({version}))),
      /version is not supported/,
    );
  }
});

test('rejects missing or extra signature slots and truncated signed messages', () => {
  const messageBytes = message();

  for (const signatures of [[], [new Uint8Array(64), new Uint8Array(64)]]) {
    assert.throws(() =>
      parseSolanaTransaction(encode(wire(messageBytes, signatures))),
    );
  }

  const bytes = wire(messageBytes);

  for (const length of [1, 32, 65, 69, bytes.length - 1]) {
    assert.throws(() => parseSolanaTransaction(encode(bytes.slice(0, length))));
  }
});

test('rejects trailing bytes and noncanonical message length prefixes', () => {
  const messageBytes = message();

  for (const malformed of [
    Uint8Array.from([...messageBytes, 0]),
    Uint8Array.from([
      ...messageBytes.subarray(0, 3),
      0x83,
      0,
      ...messageBytes.subarray(4),
    ]),
  ]) {
    assert.throws(
      () => parseSolanaTransaction(encode(wire(malformed))),
      /encoding is invalid/,
    );
  }
});

test('rejects invalid account headers and duplicate static addresses', () => {
  for (const header of [
    [0, 0, 1],
    [1, 1, 1],
    [1, 0, 3],
    [4, 0, 0],
  ]) {
    assert.throws(() =>
      parseSolanaTransaction(
        encode(
          wire(
            message({header}),
            Array.from({length: header[0]}, () => new Uint8Array(64)),
          ),
        ),
      ),
    );
  }

  assert.throws(() =>
    parseSolanaTransaction(
      encode(
        wire(message({accounts: [payer.bytes, payer.bytes, systemProgram]})),
      ),
    ),
  );
});

test('checks static program indices and static or loaded instruction accounts', () => {
  for (const [program, accounts] of [
    [0, [0, 1]],
    [3, [0, 1]],
    [2, [0, 3]],
  ]) {
    assert.throws(
      () =>
        parseSolanaTransaction(
          encode(
            wire(message({instructions: [{program, accounts, data: []}]})),
          ),
        ),
      /account index is invalid/,
    );
  }

  for (const [program, accounts] of [
    [2, [0, 1]],
    [1, [0, 3]],
  ]) {
    assert.throws(
      () =>
        parseSolanaTransaction(
          encode(
            wire(
              message({
                version: 0,
                accounts: [payer.bytes, systemProgram],
                instructions: [{program, accounts, data: []}],
                lookups: [{address: lookupTable, writable: [5], readonly: []}],
              }),
            ),
          ),
        ),
      /account index is invalid/,
    );
  }
});

test('rejects empty lookup entries and more than 256 loaded account slots', () => {
  assert.throws(
    () =>
      parseSolanaTransaction(
        encode(
          wire(
            message({
              version: 0,
              lookups: [{address: lookupTable, writable: [], readonly: []}],
            }),
          ),
        ),
      ),
    /lookup table is empty/,
  );

  assert.throws(
    () =>
      parseSolanaTransaction(
        encode(
          wire(
            message({
              version: 0,
              lookups: [
                {
                  address: lookupTable,
                  writable: Array.from({length: 254}, (_, index) => index),
                  readonly: [],
                },
              ],
            }),
          ),
        ),
      ),
    /account index is invalid/,
  );
});

test('accepts the legacy packet limit and rejects a transaction one byte larger', () => {
  const atLimit = wire(
    message({
      instructions: [
        {program: 2, accounts: [0, 1], data: new Uint8Array(1028)},
      ],
    }),
  );
  assert.equal(atLimit.length, 1232);
  assert.doesNotThrow(() => parseSolanaTransaction(encode(atLimit)));
  assert.throws(
    () => parseSolanaTransaction(encode(Uint8Array.from([...atLimit, 0]))),
    /exceeds 1232 bytes/,
  );
});
