import assert from 'node:assert/strict';
import {test} from 'node:test';

import {parseWalletConnectUri} from '../.bld/app/@lib/wallet-connect.js';

const URI = `wc:${'a'.repeat(64)}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`;

test('accepts a v2 pairing URI, preserving optional parameters and trimming surrounding whitespace', () => {
  const uri = `${URI}&methods=wc_sessionPropose,wc_sessionAuthenticate`;
  assert.equal(parseWalletConnectUri(` \n${uri}\t`), uri);
});

test('ignores unrelated, incomplete and malformed QR contents', () => {
  for (const value of [
    '',
    'plain text',
    'https://example.com',
    'FIDO:/123',
    'wc:invalid',
    URI.replace('@2', '@1'),
    URI.replace('@2', '@2junk'),
    URI.replace('a'.repeat(64), 'a'.repeat(63)),
    URI.replace('b'.repeat(64), 'g'.repeat(64)),
    URI.replace('relay-protocol=irn&', ''),
    URI.replace('relay-protocol=irn', 'relay-protocol=unknown'),
    URI.split('&symKey=')[0],
    `${URI}#fragment`,
  ]) {
    assert.equal(parseWalletConnectUri(value), undefined);
  }
});

test('rejects duplicate pairing parameters', () => {
  for (const extra of [
    `symKey=${'c'.repeat(64)}`,
    'relay-protocol=irn',
    'expiryTimestamp=9999999999&expiryTimestamp=9999999999',
  ]) {
    assert.equal(parseWalletConnectUri(`${URI}&${extra}`), undefined);
  }
});

test('accepts live expiry times and rejects expired or invalid timestamps', () => {
  const now = Math.floor(Date.now() / 1000);
  const valid = `${URI}&expiryTimestamp=${now + 300}`;
  assert.equal(parseWalletConnectUri(valid), valid);

  for (const expiry of [
    now - 1,
    now,
    '',
    '-1',
    '1.5',
    '123junk',
    'Infinity',
    '99999999999999999999',
  ]) {
    assert.equal(
      parseWalletConnectUri(`${URI}&expiryTimestamp=${expiry}`),
      undefined,
    );
  }
});
