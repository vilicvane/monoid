import assert from 'node:assert/strict';
import {test} from 'node:test';

// eslint-disable-next-line @mufan/scoped-modules -- Exercise the built internal module directly.
import {
  buildWalletConnectNamespaces,
  parseWalletConnectUri,
} from '../.bld/app/@lib/wallet-connect.js';

const URI = `wc:${'a'.repeat(64)}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`;
const ADDRESS = `0x${'ab'.repeat(20)}`;

function proposal(requiredNamespaces = {}, optionalNamespaces = {}) {
  return {params: {requiredNamespaces, optionalNamespaces}};
}

function namespace(chains, methods = [], events = []) {
  return {chains, methods, events};
}

test('approves personal signing while filtering unsupported methods and events', () => {
  const request = proposal(
    {},
    {
      eip155: namespace(
        ['eip155:1', 'eip155:137'],
        ['personal_sign', 'eth_sendTransaction'],
        ['accountsChanged', 'chainChanged', 'unsupportedEvent'],
      ),
      solana: namespace(['solana:mainnet'], ['solana_signMessage']),
    },
  );

  assert.deepEqual(buildWalletConnectNamespaces(request, [ADDRESS]), {
    eip155: {
      chains: ['eip155:1', 'eip155:137'],
      methods: ['personal_sign'],
      events: ['accountsChanged', 'chainChanged'],
      accounts: [`eip155:1:${ADDRESS}`, `eip155:137:${ADDRESS}`],
    },
  });
});

test('rejects unsupported required signing methods without advertising them as supported', () => {
  assert.throws(
    () =>
      buildWalletConnectNamespaces(
        proposal({eip155: namespace(['eip155:1'], ['eth_signTypedData_v4'])}),
        [ADDRESS],
      ),
    {message: 'This site requires unsupported wallet features.'},
  );
});

test('approves required personal signing without granting unrequested methods', () => {
  const request = proposal({
    eip155: namespace(['eip155:1'], ['personal_sign']),
  });
  assert.deepEqual(
    buildWalletConnectNamespaces(request, [ADDRESS]).eip155.methods,
    ['personal_sign'],
  );
  assert.deepEqual(
    buildWalletConnectNamespaces(proposal({eip155: namespace(['eip155:1'])}), [
      ADDRESS,
    ]).eip155.methods,
    [],
  );
});

test('rejects unsupported required namespaces and events', () => {
  for (const required of [
    {
      eip155: namespace(['eip155:1']),
      solana: namespace(['solana:mainnet']),
    },
    {eip155: namespace(['eip155:1'], [], ['unsupportedEvent'])},
  ]) {
    assert.throws(
      () => buildWalletConnectNamespaces(proposal(required), [ADDRESS]),
      {message: 'This site requires unsupported wallet features.'},
    );
  }
});

test('normalizes chain-scoped namespaces and preserves required standard events', () => {
  const request = proposal(
    {'eip155:1': namespace(undefined, [], ['accountsChanged'])},
    {'eip155:137': namespace(undefined, [], ['chainChanged'])},
  );

  assert.deepEqual(buildWalletConnectNamespaces(request, [ADDRESS]), {
    eip155: {
      chains: ['eip155:1', 'eip155:137'],
      methods: [],
      events: ['accountsChanged', 'chainChanged'],
      accounts: [`eip155:1:${ADDRESS}`, `eip155:137:${ADDRESS}`],
    },
  });
});

test('rejects unsupported required chains and filters unsupported optional chains', () => {
  for (const chain of ['eip155:mainnet', 'eip155:-1', 'solana:mainnet']) {
    assert.throws(
      () =>
        buildWalletConnectNamespaces(
          proposal({eip155: namespace(['eip155:1', chain])}),
          [ADDRESS],
        ),
      {message: 'This site requires unsupported wallet features.'},
    );
  }

  const approved = buildWalletConnectNamespaces(
    proposal(
      {},
      {eip155: namespace(['eip155:1', 'eip155:mainnet', 'solana:mainnet'])},
    ),
    [ADDRESS],
  );
  assert.deepEqual(approved.eip155.chains, ['eip155:1']);
  assert.deepEqual(approved.eip155.accounts, [`eip155:1:${ADDRESS}`]);
});

test('deduplicates chains and account identities without changing the proposal', () => {
  const request = proposal(
    {eip155: namespace(['eip155:1'])},
    {eip155: namespace(['eip155:1', 'eip155:137', 'eip155:137'])},
  );
  const original = structuredClone(request);
  const firstAddress = `0x${'aB'.repeat(20)}`;
  const approved = buildWalletConnectNamespaces(request, [
    firstAddress,
    ADDRESS,
  ]);

  assert.deepEqual(approved.eip155.accounts, [
    `eip155:1:${firstAddress}`,
    `eip155:137:${firstAddress}`,
  ]);
  assert.deepEqual(approved.eip155.chains, ['eip155:1', 'eip155:137']);
  assert.deepEqual(request, original);
});

test('requires selected accounts and requested EVM chains', () => {
  assert.throws(
    () =>
      buildWalletConnectNamespaces(
        proposal({eip155: namespace(['eip155:1'])}),
        [],
      ),
    {message: 'Choose at least one account.'},
  );

  for (const request of [
    proposal(),
    proposal({}, {solana: namespace(['solana:mainnet'])}),
  ]) {
    assert.throws(() => buildWalletConnectNamespaces(request, [ADDRESS]), {
      message: 'This site requires unsupported wallet features.',
    });
  }
});

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
