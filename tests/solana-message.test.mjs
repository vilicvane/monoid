import assert from 'node:assert/strict';
import {test} from 'node:test';

import {getCompiledTransactionMessageDecoder} from '@solana/transaction-messages';

const {assertSolanaMessage} = await import(
  '../.bld/app/@lib/solana-message.js'
);

const signer = Uint8Array.from(
  Buffer.from(
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    'hex',
  ),
);
const recipient = new Uint8Array(32).fill(2);
const systemProgram = new Uint8Array(32);
const blockhash = new Uint8Array(32).fill(4);
const transferData = [2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];

// Wire fixtures are assembled independently of the decoder and contain a SOL transfer.
const legacy = Uint8Array.from([
  1,
  0,
  1,
  3,
  ...signer,
  ...recipient,
  ...systemProgram,
  ...blockhash,
  1,
  2,
  2,
  0,
  1,
  12,
  ...transferData,
]);
const version0 = Uint8Array.from([0x80, ...legacy, 0]);
const version0WithLookup = Uint8Array.from([
  0x80,
  1,
  0,
  1,
  2,
  ...signer,
  ...systemProgram,
  ...blockhash,
  1,
  1,
  2,
  0,
  2,
  12,
  ...transferData,
  1,
  ...recipient,
  1,
  0,
  0,
]);
const version1 = Uint8Array.from([
  0x81,
  1,
  0,
  1,
  0,
  0,
  0,
  0,
  ...blockhash,
  1,
  3,
  ...signer,
  ...recipient,
  ...systemProgram,
  2,
  2,
  12,
  0,
  0,
  1,
  ...transferData,
]);

test('rejects serialized signing messages for legacy, v0, lookup tables and v1', () => {
  const decoder = getCompiledTransactionMessageDecoder();

  for (const [message, version] of [
    [legacy, 'legacy'],
    [version0, 0],
    [version0WithLookup, 0],
    [version1, 1],
  ]) {
    const [decoded, offset] = decoder.read(message, 0);
    assert.equal(decoded.version, version);
    assert.equal(offset, message.length);
    assert.equal(decoded.header.numSignerAccounts, 1);
    assert.throws(() => assertSolanaMessage(message), {
      message: 'Use transaction signing for this message.',
    });
  }
});

test('preserves ordinary UTF-8, including Unicode leading bytes and control characters', () => {
  for (const text of [
    '',
    'Hello from AppKit',
    '中文消息',
    '🪙 Sign in',
    '\ufeffmessage',
    '\tline one\r\nline two\0',
  ]) {
    const message = new TextEncoder().encode(text);
    const original = message.slice();
    assert.doesNotThrow(() => assertSolanaMessage(message));
    assert.deepEqual(message, original);
  }
});

test('allows nontransaction binary and reserved off-chain prefixes unchanged', () => {
  for (const message of [
    Uint8Array.of(0, 1, 2, 255),
    new Uint8Array(37),
    Uint8Array.of(0x80, 1, 2),
    Uint8Array.of(0xff, 0x73, 0x6f, 0x6c, 0x61, 0x6e, 0x61),
  ]) {
    const original = message.slice();
    assert.doesNotThrow(() => assertSolanaMessage(message));
    assert.deepEqual(message, original);
  }
});

test('allows incomplete headers but rejects transaction-shaped messages with trailing bytes', () => {
  for (const message of [legacy, version0, version1]) {
    assert.doesNotThrow(() => assertSolanaMessage(message.slice(0, 20)));
    assert.throws(() =>
      assertSolanaMessage(Uint8Array.from([...message, 0, 255])),
    );
  }
});

test('does not authorize raw signing for unknown binary transaction versions', () => {
  for (const prefix of [0x82, 0xbf, 0xc0, 0xfe]) {
    assert.throws(
      () => assertSolanaMessage(Uint8Array.from([prefix, ...legacy])),
      {message: 'This transaction message version is not supported.'},
    );
  }
});
