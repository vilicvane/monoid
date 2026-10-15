import assert from 'node:assert/strict';
import {test} from 'node:test';

import {buildAuthObject, formatMessage} from '@walletconnect/utils';
import {Wallet, verifyMessage} from 'ethers';

// eslint-disable-next-line @mufan/scoped-modules -- Exercise the built internal module directly.
import {
  buildWalletConnectAuthentication,
  getWalletConnectRequestExpiry,
  validateWalletConnectAuthentication,
} from '../.bld/app/@lib/wallet-connect-authentication.js';

// Public test keys; never use these accounts for funds.
const wallets = [1, 2].map(
  value => new Wallet(`0x${value.toString(16).padStart(64, '0')}`),
);
const addresses = wallets.map(wallet => wallet.address);
const authentication = (overrides = {}) => ({
  type: 'caip122',
  version: '1',
  domain: 'example.com',
  aud: 'https://example.com/login',
  nonce: 'publicnonce123',
  iat: '2026-10-15T00:00:00.000Z',
  chains: ['eip155:1', 'eip155:137'],
  ...overrides,
});
const proposal = (requests = [authentication()]) => ({
  params: {
    expiryTimestamp: 2_000,
    requiredNamespaces: {},
    optionalNamespaces: {
      eip155: {
        chains: ['eip155:1', 'eip155:137'],
        methods: [],
        events: [],
      },
    },
    requests: {authentication: requests},
  },
});

test('builds every request, approved chain and unique account without changing the request', () => {
  const first = authentication({
    chains: ['eip155:137', 'eip155:1', 'eip155:1', 'eip155:10'],
    resources: ['https://example.com/terms'],
  });
  const second = authentication({
    chains: ['eip155:137'],
    nonce: 'anothernonce123',
    statement: 'Sign in to your account.',
  });
  const request = proposal([first, second]);
  const original = structuredClone(request);
  const results = buildWalletConnectAuthentication(request, [
    ...addresses,
    addresses[0].toLowerCase(),
  ]);

  assert.deepEqual(
    results.map(({iss}) => iss),
    ['eip155:1', 'eip155:137', 'eip155:137'].flatMap(chain =>
      addresses.map(address => `did:pkh:${chain}:${address}`),
    ),
  );
  assert.deepEqual(
    results.map(({request: auth}) => auth),
    [first, first, first, first, second, second],
  );
  assert.deepEqual(
    results.map(({address}) => address),
    [...addresses, ...addresses, ...addresses],
  );
  assert.equal(
    results[0].message,
    `example.com wants you to sign in with your Ethereum account:\n${addresses[0]}\n\n\nURI: https://example.com/login\nVersion: 1\nChain ID: 1\nNonce: publicnonce123\nIssued At: 2026-10-15T00:00:00.000Z\nResources:\n- https://example.com/terms`,
  );
  assert.deepEqual(request, original);
});

test('ordinary proposals require no authentication results', () => {
  const request = proposal();
  delete request.params.requests;

  assert.deepEqual(buildWalletConnectAuthentication(request, []), []);
  assert.doesNotThrow(() => validateWalletConnectAuthentication([], []));
  assert.equal(getWalletConnectRequestExpiry(request), 2_000_000);
});

test('rejects unsupported authentication formats and signature constraints', () => {
  for (const overrides of [
    {type: 'unsupported'},
    {version: '2'},
    {signatureTypes: {eip155: ['eip191']}},
    {signatureTypes: {eip155: ['eip1271']}},
    {signatureTypes: {'eip155:1': ['eip191']}},
    {signatureTypes: {solana: ['ed25519']}},
  ]) {
    assert.throws(
      () =>
        buildWalletConnectAuthentication(
          proposal([authentication(overrides)]),
          addresses,
        ),
      /sign-in method is not supported/,
    );
  }
});

test('does not sign delegated ReCap permissions or unapproved networks', () => {
  assert.throws(
    () =>
      buildWalletConnectAuthentication(
        proposal([authentication({resources: ['urn:recap:e30=']})]),
        addresses,
      ),
    /unsupported permissions/,
  );

  for (const chains of [[], ['eip155:10'], ['solana:mainnet']]) {
    assert.throws(
      () =>
        buildWalletConnectAuthentication(
          proposal([authentication({chains})]),
          addresses,
        ),
      /unsupported network/,
    );
  }
});

test('rejects line breaks that could forge fields in the displayed sign-in message', () => {
  for (const field of [
    'domain',
    'aud',
    'nonce',
    'iat',
    'statement',
    'requestId',
    'resources',
  ]) {
    for (const newline of ['\r', '\n']) {
      const value = `original${newline}URI: https://other.example`;
      const request = authentication({
        [field]: field === 'resources' ? [value] : value,
      });
      assert.throws(
        () => buildWalletConnectAuthentication(proposal([request]), addresses),
        /Invalid sign-in message fields/,
      );
    }
  }
});

test('honors authentication time bounds and the earliest request expiry', context => {
  context.mock.timers.enable({apis: ['Date'], now: 1_000_000});

  for (const overrides of [
    {exp: new Date(1_000_000).toISOString()},
    {exp: 'invalid'},
    {nbf: new Date(1_000_001).toISOString()},
    {nbf: 'invalid'},
  ]) {
    assert.throws(
      () =>
        buildWalletConnectAuthentication(
          proposal([authentication(overrides)]),
          addresses,
        ),
      /not currently valid/,
    );
  }

  const request = proposal([
    authentication({
      nbf: new Date(1_000_000).toISOString(),
      exp: new Date(1_500_000).toISOString(),
    }),
    authentication({exp: new Date(1_200_000).toISOString()}),
  ]);
  assert.equal(buildWalletConnectAuthentication(request, addresses).length, 8);
  assert.equal(getWalletConnectRequestExpiry(request), 1_200_000);
  request.params.expiryTimestamp = 1_100;
  assert.equal(getWalletConnectRequestExpiry(request), 1_100_000);
});

test('accepts complete EIP-191 results and rejects partial or altered messages and issuers', async () => {
  const expected = buildWalletConnectAuthentication(proposal(), addresses);
  const results = await Promise.all(
    expected.map(async ({request, iss, message, address}) => {
      const wallet = wallets.find(wallet => wallet.address === address);
      const signature = await wallet.signMessage(message);
      assert.equal(verifyMessage(message, signature), address);
      return buildAuthObject(request, {t: 'eip191', s: signature}, iss);
    }),
  );
  assert.doesNotThrow(() =>
    validateWalletConnectAuthentication(expected, results),
  );

  const changes = [
    result => (result.p.iss = `did:pkh:eip155:1:${addresses[1]}`),
    result => (result.p.domain = 'other.example'),
    result => (result.p.aud = 'https://example.com/another-login'),
    result => (result.p.nonce = 'changednonce123'),
    result => (result.p.statement = 'Authorize a different action.'),
    result => (result.s.t = 'eip1271'),
    result => (result.h.t = 'unsupported'),
  ];
  const invalid = [results.slice(1), [...results, results[0]]];
  for (const change of changes) {
    const modified = structuredClone(results);
    change(modified[0]);
    invalid.push(modified);
  }
  for (const modified of invalid) {
    assert.throws(
      () => validateWalletConnectAuthentication(expected, modified),
      /Sign all selected accounts before connecting/,
    );
  }
  assert.equal(
    formatMessage(results[0].p, results[0].p.iss),
    expected[0].message,
  );
});
