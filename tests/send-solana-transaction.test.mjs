import assert from 'node:assert/strict';
import {createPrivateKey, createPublicKey, sign} from 'node:crypto';
import {test} from 'node:test';

import {base58} from '@scure/base';

import {
  getSignedSolanaTransactionSignature,
  sendSolanaTransaction,
} from '../.bld/app/@lib/send-solana-transaction.js';
import {parseSolanaTransaction} from '../.bld/app/@lib/solana-transaction.js';

function signingKey(byte) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, byte),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey)
    .export({format: 'der', type: 'spki'})
    .subarray(-32);

  return {privateKey, publicKey};
}

const payer = signingKey(1);
const signer = signingKey(2);
const blockhash = Buffer.alloc(32, 3);

function transaction(version = 'legacy') {
  const message = Buffer.from([
    ...(version === 'legacy' ? [] : [0x80]),
    2,
    0,
    0,
    2,
    ...payer.publicKey,
    ...signer.publicKey,
    ...blockhash,
    0,
    ...(version === 'legacy' ? [] : [0]),
  ]);
  const signatures = [payer, signer].map(key =>
    sign(null, message, key.privateKey),
  );
  const bytes = Buffer.concat([Buffer.from([2]), ...signatures, message]);

  return {encoded: bytes.toString('base64'), bytes, message, signatures};
}

test('sends the original legacy and v0 bytes and returns the fee payer signature', async () => {
  for (const version of ['legacy', 0]) {
    const {encoded, signatures, message} = transaction(version);
    const expected = base58.encode(signatures[0]);
    const calls = [];

    assert.equal(getSignedSolanaTransactionSignature(encoded), expected);
    assert.notEqual(expected, base58.encode(signatures[1]));
    const result = await sendSolanaTransaction(encoded, async (...args) => {
      calls.push(args);
      return expected;
    });

    assert.equal(result, expected);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'sendTransaction');
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), [
      encoded,
      {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      },
    ]);
    const sent = parseSolanaTransaction(calls[0][1][0]);
    assert.deepEqual(Buffer.from(sent.messageBytes), message);
    assert.equal(sent.compiled.lifetimeToken, base58.encode(blockhash));
    assert.deepEqual(sent.signatures.map(Buffer.from), signatures);
  }
});

test('passes requested send options and cancellation through without accepting encoding overrides', async () => {
  const {encoded} = transaction();
  const signal = new AbortController().signal;
  const options = {
    skipPreflight: true,
    preflightCommitment: 'processed',
    maxRetries: 0,
    minContextSlot: 42,
  };

  await sendSolanaTransaction(
    encoded,
    async (method, params, receivedSignal) => {
      assert.equal(method, 'sendTransaction');
      assert.deepEqual(params, [encoded, {encoding: 'base64', ...options}]);
      assert.equal(receivedSignal, signal);
      return getSignedSolanaTransactionSignature(encoded);
    },
    {...options, encoding: 'base58'},
    signal,
  );
});

test('rejects missing and invalid signatures before contacting the RPC, even with preflight disabled', async () => {
  const {bytes} = transaction();

  for (const slot of [0, 1]) {
    for (const value of [0, 1]) {
      const altered = Buffer.from(bytes);
      altered.fill(value, 1 + slot * 64, 1 + (slot + 1) * 64);
      const encoded = altered.toString('base64');
      const expected = value
        ? /invalid signature/
        : /missing a required signature/;

      assert.throws(
        () => getSignedSolanaTransactionSignature(encoded),
        expected,
      );
      await assert.rejects(
        sendSolanaTransaction(encoded, async () => assert.fail('RPC called'), {
          skipPreflight: true,
        }),
        expected,
      );
    }
  }
});

test('requires the RPC transaction id to match the signed fee payer signature', async () => {
  const {encoded, signatures} = transaction();

  for (const result of [base58.encode(signatures[1]), '', null, {}]) {
    await assert.rejects(
      sendSolanaTransaction(encoded, async () => result),
      /different transaction signature/,
    );
  }
});

test('preserves RPC errors and resends identical bytes on an explicit retry', async () => {
  const {encoded} = transaction();
  const error = new Error('Transaction simulation failed: Blockhash not found');
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({method, params});

    if (calls.length === 1) {
      throw error;
    }

    return getSignedSolanaTransactionSignature(encoded);
  };

  await assert.rejects(
    sendSolanaTransaction(encoded, rpc),
    value => value === error,
  );
  await sendSolanaTransaction(encoded, rpc);
  assert.deepEqual(calls[1], calls[0]);
});

test('does not submit an already cancelled request', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    sendSolanaTransaction(
      transaction().encoded,
      async () => assert.fail('RPC called'),
      {},
      controller.signal,
    ),
    {name: 'AbortError'},
  );
});
