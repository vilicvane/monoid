import assert from 'node:assert/strict';
import {test} from 'node:test';

import {TEST_NETWORK, p2tr, p2wpkh} from '@scure/btc-signer';
import {getBytes} from 'ethers';

const {parseBitcoinPaymentRequest} = await import(
  '../.bld/app/@lib/bitcoin-payment-request.js'
);

// Public secp256k1 generator; no private wallet or device data.
const publicKey = getBytes(
  '0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
);
const segwit = p2wpkh(publicKey).address;
const taproot = p2tr(publicKey.subarray(1)).address;
const legacy = '1BitcoinEaterAddressDontSendf59kuE';

test('raw mainnet addresses trim outer whitespace and normalize supported address encodings', () => {
  for (const address of [legacy, segwit, taproot]) {
    assert.deepEqual(parseBitcoinPaymentRequest(` \n${address}\t `), {address});
  }
  assert.deepEqual(parseBitcoinPaymentRequest(segwit.toUpperCase()), {
    address: segwit,
  });
});

test('bitcoin scheme is case insensitive and an omitted amount stays omitted', () => {
  for (const scheme of ['bitcoin', 'BITCOIN', 'bItCoIn']) {
    assert.deepEqual(parseBitcoinPaymentRequest(`${scheme}:${segwit}`), {
      address: segwit,
    });
  }
  assert.deepEqual(
    parseBitcoinPaymentRequest(
      `bitcoin:${taproot}?label=Example&message=Donation%20for%20project`,
    ),
    {address: taproot},
  );
});

test('payment amounts normalize exactly without floating point or unit conversion', () => {
  for (const [input, expected] of [
    ['0.00000001', '0.00000001'],
    ['20.30000000', '20.3'],
    ['20999999.99999999', '20999999.99999999'],
    ['21000000', '21000000'],
    ['50.00', '50'],
    ['0.00000000', '0'],
    ['%30%2E%31', '0.1'],
  ]) {
    assert.deepEqual(
      parseBitcoinPaymentRequest(`bitcoin:${legacy}?amount=${input}`),
      {address: legacy, amount: expected},
    );
  }
});

test('optional extensions are ignored and query names remain case sensitive', () => {
  assert.deepEqual(
    parseBitcoinPaymentRequest(
      `bitcoin:${segwit}?label=%E6%94%B6%E6%AC%BE&message=A+B&something=50&flag&Amount=invalid&amount=1.20`,
    ),
    {address: segwit, amount: '1.2'},
  );
  assert.deepEqual(
    parseBitcoinPaymentRequest(`bitcoin:${segwit}?REQ-something=50`),
    {address: segwit},
  );
});

test('required extensions and duplicate amounts cannot be silently ignored', () => {
  for (const query of [
    'req-something=50',
    'req-amount=1',
    '%72eq-option=1',
    'amount=1&req-option',
  ]) {
    assert.throws(
      () => parseBitcoinPaymentRequest(`bitcoin:${segwit}?${query}`),
      /requires an unsupported option/,
    );
  }
  for (const query of [
    'amount=1&amount=2',
    'amount=0&amount=0',
    'amount=1&am%6Funt=2',
  ]) {
    assert.throws(
      () => parseBitcoinPaymentRequest(`bitcoin:${segwit}?${query}`),
      /more than one amount/,
    );
  }
});

test('invalid, negative, inexact and overflowing amounts are rejected', () => {
  for (const amount of [
    '',
    '-1',
    '+1',
    '%2B1',
    '1e-8',
    '0.000000001',
    '21000000.00000001',
    '1000000000000000000000',
    '1,000',
    'NaN',
    'Infinity',
    '%201',
    '1%20',
    '1%0A',
    '1.2.3',
  ]) {
    assert.throws(() =>
      parseBitcoinPaymentRequest(`bitcoin:${segwit}?amount=${amount}`),
    );
  }
  assert.throws(() => parseBitcoinPaymentRequest(`bitcoin:${segwit}?amount`));
});

test('malformed URI paths, fragments, escaping and alternative schemes are rejected', () => {
  for (const value of [
    '',
    'bitcoin:',
    `bitcoin:// ${segwit}`,
    `bitcoin://${segwit}`,
    `bitcoin:${segwit}/`,
    `bitcoin:${segwit}#amount=1`,
    `bitcoin:${segwit}?amount=1#label`,
    `bitcoin:${segwit} ?amount=1`,
    `bitcoin:%62${segwit.slice(1)}`,
    `bitcoin:${segwit}?label=%`,
    `bitcoin:${segwit}?label=%FF`,
    `bitcoin:${segwit}?label=raw space`,
    `bitcoin:${segwit}?=value`,
    `bitcoin:${segwit}?amount=1=2`,
    `https://example.com/${segwit}`,
    `lightning:${segwit}`,
    `${segwit}?amount=1`,
  ]) {
    assert.throws(() => parseBitcoinPaymentRequest(value));
  }
});

test('wrong networks and invalid address checksums are rejected in raw and URI forms', () => {
  const testnet = p2wpkh(publicKey, TEST_NETWORK).address;
  for (const address of [
    testnet,
    `${segwit.slice(0, -1)}x`,
    'invalid-address',
  ]) {
    assert.throws(() => parseBitcoinPaymentRequest(address), /mainnet address/);
    assert.throws(() => parseBitcoinPaymentRequest(`bitcoin:${address}`));
  }
});
