import assert from 'node:assert/strict';
import {test} from 'node:test';

// eslint-disable-next-line @mufan/scoped-modules -- Exercise the built internal module directly.
import {
  buildWalletConnectNamespaces,
  getWalletConnectAddressType,
  getWalletConnectProposalAddressTypes,
  parseWalletConnectUri,
} from '../.bld/app/@lib/wallet-connect.js';

const URI = `wc:${'a'.repeat(64)}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`;
const ADDRESS = `0x${'ab'.repeat(20)}`;
const SOLANA_CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SOLANA_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function proposal(requiredNamespaces = {}, optionalNamespaces = {}) {
  return {params: {requiredNamespaces, optionalNamespaces}};
}

function namespace(chains, methods = [], events = []) {
  return {chains, methods, events};
}

test('approves message signing and transactions while filtering unsupported methods and events', () => {
  const request = proposal(
    {},
    {
      eip155: namespace(
        ['eip155:1', 'eip155:137'],
        [
          'personal_sign',
          'eth_signTypedData_v4',
          'eth_sendTransaction',
          'eth_sign',
        ],
        ['accountsChanged', 'chainChanged', 'unsupportedEvent'],
      ),
      solana: namespace(['solana:mainnet'], ['solana_signMessage']),
    },
  );

  assert.deepEqual(buildWalletConnectNamespaces(request, [ADDRESS]), {
    eip155: {
      chains: ['eip155:1', 'eip155:137'],
      methods: ['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction'],
      events: ['accountsChanged', 'chainChanged'],
      accounts: [`eip155:1:${ADDRESS}`, `eip155:137:${ADDRESS}`],
    },
  });
});

test('rejects unsupported required signing methods without advertising them as supported', () => {
  assert.throws(
    () =>
      buildWalletConnectNamespaces(
        proposal({eip155: namespace(['eip155:1'], ['eth_signTypedData_v3'])}),
        [ADDRESS],
      ),
    {message: 'This site requires unsupported wallet features.'},
  );
});

test('approves required signing without granting unrequested methods', () => {
  for (const method of [
    'personal_sign',
    'eth_signTypedData_v4',
    'eth_sendTransaction',
  ]) {
    const request = proposal({
      eip155: namespace(['eip155:1'], [method]),
    });
    assert.deepEqual(
      buildWalletConnectNamespaces(request, [ADDRESS]).eip155.methods,
      [method],
    );
  }
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

test('requires selected accounts and supported requested chains', () => {
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

test('grants Solana message signing, transaction signing and sending', () => {
  const chains = [
    SOLANA_CHAIN,
    'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
  ];
  const request = proposal(
    {},
    {
      solana: namespace(
        chains,
        [
          'solana_signMessage',
          'solana_signTransaction',
          'solana_signAllTransactions',
          'solana_signAndSendTransaction',
          'solana_requestAccounts',
          'solana_getAccounts',
        ],
        ['accountsChanged', 'chainChanged'],
      ),
    },
  );

  assert.deepEqual(getWalletConnectProposalAddressTypes(request), ['solana']);
  assert.deepEqual(buildWalletConnectNamespaces(request, [SOLANA_ADDRESS]), {
    solana: {
      chains,
      methods: [
        'solana_signMessage',
        'solana_signTransaction',
        'solana_signAllTransactions',
        'solana_signAndSendTransaction',
      ],
      events: ['accountsChanged', 'chainChanged'],
      accounts: chains.map(chain => `${chain}:${SOLANA_ADDRESS}`),
    },
  });
});

test('supports required Solana signing and broadcasting', () => {
  const request = proposal({
    solana: namespace([SOLANA_CHAIN], ['solana_signMessage']),
  });
  assert.deepEqual(
    buildWalletConnectNamespaces(request, [SOLANA_ADDRESS]).solana.methods,
    ['solana_signMessage'],
  );
  request.params.requiredNamespaces.solana.methods = ['solana_signTransaction'];
  assert.deepEqual(
    buildWalletConnectNamespaces(request, [SOLANA_ADDRESS]).solana.methods,
    ['solana_signTransaction'],
  );
  request.params.requiredNamespaces.solana.methods = [
    'solana_signAndSendTransaction',
  ];
  assert.deepEqual(
    buildWalletConnectNamespaces(request, [SOLANA_ADDRESS]).solana.methods,
    ['solana_signAndSendTransaction'],
  );
});

test('normalizes chain-scoped Solana requests and preserves case-distinct accounts', () => {
  const anotherAddress = SOLANA_ADDRESS.slice(0, -1) + 'V';
  const request = proposal({
    [SOLANA_CHAIN]: namespace(undefined, [], ['accountsChanged']),
  });
  const approved = buildWalletConnectNamespaces(request, [
    SOLANA_ADDRESS,
    anotherAddress,
    SOLANA_ADDRESS,
  ]);

  assert.deepEqual(approved.solana.accounts, [
    `${SOLANA_CHAIN}:${SOLANA_ADDRESS}`,
    `${SOLANA_CHAIN}:${anotherAddress}`,
  ]);
});

test('keeps EVM and Solana accounts in their own namespaces', () => {
  const request = proposal({
    eip155: namespace(['eip155:1'], ['personal_sign']),
    solana: namespace([SOLANA_CHAIN]),
  });
  assert.deepEqual(getWalletConnectProposalAddressTypes(request), [
    'evm',
    'solana',
  ]);
  const approved = buildWalletConnectNamespaces(request, [
    ADDRESS,
    SOLANA_ADDRESS,
  ]);
  assert.deepEqual(approved.eip155.accounts, [`eip155:1:${ADDRESS}`]);
  assert.deepEqual(approved.solana.accounts, [
    `${SOLANA_CHAIN}:${SOLANA_ADDRESS}`,
  ]);

  for (const selected of [[ADDRESS], [SOLANA_ADDRESS]]) {
    assert.throws(() => buildWalletConnectNamespaces(request, selected), {
      message: 'This site requires unsupported wallet features.',
    });
  }
});

test('does not approve an optional namespace without matching selected accounts', () => {
  const request = proposal(
    {},
    {
      eip155: namespace(['eip155:1']),
      solana: namespace([SOLANA_CHAIN]),
    },
  );
  assert.deepEqual(
    Object.keys(buildWalletConnectNamespaces(request, [SOLANA_ADDRESS])),
    ['solana'],
  );
  assert.deepEqual(
    Object.keys(buildWalletConnectNamespaces(request, [ADDRESS])),
    ['eip155'],
  );
});

test('rejects invalid account formats and unsupported Solana cluster identifiers', () => {
  assert.equal(getWalletConnectAddressType(ADDRESS), 'evm');
  assert.equal(getWalletConnectAddressType(SOLANA_ADDRESS), 'solana');
  for (const address of [
    '',
    '0xABC',
    'solana',
    '0'.repeat(32),
    '1'.repeat(31),
    '1'.repeat(33),
  ]) {
    assert.equal(getWalletConnectAddressType(address), undefined);
  }

  for (const chain of ['solana:mainnet', 'solana:unknown']) {
    const request = proposal({solana: namespace([chain])});
    assert.deepEqual(getWalletConnectProposalAddressTypes(request), []);
    assert.throws(() =>
      buildWalletConnectNamespaces(request, [SOLANA_ADDRESS]),
    );
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
