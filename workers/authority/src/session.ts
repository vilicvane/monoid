import {concat, decode, encode, utf8} from './encoding.js';

export async function createSessionKey(master: Uint8Array): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey('raw', master, 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: utf8('Monoid Authority OAuth Storage v1'),
    },
    key,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt'],
  );
}

// Provider credentials are encrypted at application level as well as by DO storage.
export async function sealSession(
  value: string,
  key: CryptoKey,
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv: nonce},
    key,
    utf8(value),
  );
  return encode(concat(nonce, new Uint8Array(ciphertext)));
}

export async function openSession(
  value: string,
  key: CryptoKey,
): Promise<string> {
  const bytes = decode(value);
  const plaintext = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: bytes.slice(0, 12)},
    key,
    bytes.slice(12),
  );
  return new TextDecoder().decode(plaintext);
}
