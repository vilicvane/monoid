import assert from 'node:assert/strict';
import {createPrivateKey, createPublicKey, sign, verify} from 'node:crypto';
import {test} from 'node:test';

import {base58} from '@scure/base';

import {
  CBORAppletError,
  CardItemNotFoundError,
} from '../.bld/app/@lib/cbor-applet.js';
import {MonoidCardError} from '../.bld/app/@lib/monoid/card-error.js';
import {signSolanaMessage} from '../.bld/app/@lib/monoid/sign-solana-message.js';
import {verifySolanaSignature} from '../.bld/app/@lib/solana-signature.js';

// Public test seeds. Sign independently with Node's OpenSSL implementation.
function createSigningKey(value) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, value),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const key = createPublicKey(privateKey);
  const publicKey = new Uint8Array(
    key.export({format: 'der', type: 'spki'}).subarray(-32),
  );

  return {privateKey, key, publicKey, address: base58.encode(publicKey)};
}

const signingKey = createSigningKey(1);
const otherKey = createSigningKey(2);
const {address, publicKey} = signingKey;
const message = new TextEncoder().encode('Sign in to Monoid: 登录 👋');
const rawKey = {
  type: 'ed25519',
  index: new Uint8Array(Buffer.from('04010000000000000001', 'hex')),
};
const derivedKey = {
  type: 'seed',
  index: new Uint8Array(Buffer.from('02400000000000000002', 'hex')),
  derivation: {
    type: 'slip10',
    curve: 'ed25519',
    path: new Uint8Array(
      Buffer.from('8000002c800001f58000000180000000', 'hex'),
    ),
  },
};

function signBytes(bytes, signer = signingKey) {
  return new Uint8Array(sign(null, bytes, signer.privateKey));
}

function createApplet() {
  return {
    viewKey: async () => ({publicKey}),
    sign: async ({message: bytes}) => ({signature: signBytes(bytes)}),
  };
}

test('signs the exact message bytes with pure Ed25519 and returns base58', async () => {
  for (const bytes of [
    message,
    new Uint8Array(),
    Uint8Array.of(0xff, 0, 0xfe),
  ]) {
    const applet = createApplet();
    applet.sign = async request => {
      assert.deepEqual(request, {
        ...rawKey,
        cipher: 'ed25519',
        message: bytes,
      });
      return {signature: signBytes(request.message)};
    };

    const result = await signSolanaMessage(applet, rawKey, bytes, address);

    assert.equal(result, base58.encode(signBytes(bytes)));
    assert.equal(
      verify(null, bytes, signingKey.key, base58.decode(result)),
      true,
    );
    assert.equal(verifySolanaSignature(bytes, result, address), true);
  }
});

test('preserves raw and distinct seed key references in both card operations', async () => {
  const otherDerivedKey = {
    ...derivedKey,
    index: new Uint8Array(Buffer.from('02400000000000000003', 'hex')),
    derivation: {
      ...derivedKey.derivation,
      path: new Uint8Array(
        Buffer.from('8000002c800001f58000000280000000', 'hex'),
      ),
    },
  };

  for (const key of [rawKey, derivedKey, otherDerivedKey]) {
    const applet = createApplet();
    const calls = [];
    applet.viewKey = async request => {
      calls.push('viewKey');
      assert.deepEqual(request, key);
      return {publicKey};
    };
    applet.sign = async request => {
      calls.push('sign');
      assert.deepEqual(request, {...key, cipher: 'ed25519', message});
      return {signature: signBytes(request.message)};
    };

    await signSolanaMessage(applet, key, message, address);
    assert.deepEqual(calls, ['viewKey', 'sign']);
  }
});

test('snapshots the message before waiting for the card key', async () => {
  const bytes = message.slice();
  const applet = createApplet();
  applet.viewKey = async () => {
    bytes.fill(0);
    return {publicKey};
  };

  const result = await signSolanaMessage(applet, rawKey, bytes, address);

  assert.equal(verifySolanaSignature(message, result, address), true);
  assert.equal(verifySolanaSignature(bytes, result, address), false);
});

test('checks request activity before card access, before signing and before returning', async () => {
  for (const expiresAt of [1, 2, 3]) {
    const applet = createApplet();
    const calls = [];
    let checkpoints = 0;
    applet.viewKey = async () => {
      calls.push('viewKey');
      return {publicKey};
    };
    applet.sign = async () => {
      calls.push('sign');
      return {signature: signBytes(message)};
    };

    await assert.rejects(
      signSolanaMessage(applet, rawKey, message, address, () => {
        if (++checkpoints === expiresAt) throw new Error('Request expired');
      }),
      /Request expired/,
    );
    assert.deepEqual(calls, ['viewKey', 'sign'].slice(0, expiresAt - 1));
  }
});

test('checks the exact case-sensitive account address before signing', async () => {
  for (const expectedAddress of [otherKey.address, address.toLowerCase()]) {
    assert.notEqual(expectedAddress, address);
    const applet = createApplet();
    applet.sign = async () => assert.fail('Unexpected sign call');

    await assert.rejects(
      signSolanaMessage(applet, rawKey, message, expectedAddress),
      error =>
        error instanceof MonoidCardError &&
        error.message === 'Account not on this card',
    );
  }
});

test('rejects an invalid card public key before signing', async () => {
  for (const length of [0, 31, 33, 65]) {
    const invalidKey = new Uint8Array(length);
    const applet = {
      viewKey: async () => ({publicKey: invalidKey}),
      sign: async () => assert.fail('Unexpected sign call'),
    };

    await assert.rejects(
      signSolanaMessage(applet, rawKey, message, base58.encode(invalidKey)),
      MonoidCardError,
    );
  }
});

test('rejects signatures for another key or different message', async () => {
  for (const signature of [
    signBytes(message, otherKey),
    signBytes(Uint8Array.of(...message, 0)),
  ]) {
    const applet = createApplet();
    applet.sign = async () => ({signature});

    await assert.rejects(
      signSolanaMessage(applet, rawKey, message, address),
      /signature does not match/,
    );
  }
});

test('rejects card responses that are not 64-byte Ed25519 signatures', async () => {
  for (const length of [0, 63, 65]) {
    const applet = createApplet();
    applet.sign = async () => ({signature: new Uint8Array(length)});

    await assert.rejects(
      signSolanaMessage(applet, rawKey, message, address),
      /Invalid ed25519 signature length/,
    );
  }
});

test('maps missing-key errors to the short card prompt and preserves other errors', async () => {
  for (const operation of ['viewKey', 'sign']) {
    const applet = createApplet();
    const missing = new CardItemNotFoundError({code: 'NOT_FOUND'});
    applet[operation] = async () => {
      throw missing;
    };

    await assert.rejects(
      signSolanaMessage(applet, rawKey, message, address),
      error =>
        error instanceof MonoidCardError &&
        error.message === 'Account not on this card' &&
        error.cause === missing,
    );

    for (const failure of [
      new CBORAppletError({code: 'UNAUTHORIZED'}),
      Object.assign(new Error('Tag lost'), {code: 'TAG_LOST'}),
      new Error('NOT_FOUND'),
    ]) {
      applet[operation] = async () => {
        throw failure;
      };
      await assert.rejects(
        signSolanaMessage(applet, rawKey, message, address),
        error => error === failure,
      );
    }
  }
});

test('signature verification rejects malformed encodings, lengths and small-order keys', () => {
  const result = base58.encode(signBytes(message));

  for (const invalid of ['', '0x1234', base58.encode(new Uint8Array(31))]) {
    assert.equal(verifySolanaSignature(message, result, invalid), false);
    assert.equal(verifySolanaSignature(message, invalid, address), false);
  }

  const identity = new Uint8Array(32);
  const forgedSignature = new Uint8Array(64);
  identity[0] = 1;
  forgedSignature[0] = 1;

  assert.equal(
    verifySolanaSignature(
      message,
      base58.encode(forgedSignature),
      base58.encode(identity),
    ),
    false,
  );
});
