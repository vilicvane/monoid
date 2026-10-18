import assert from 'node:assert/strict';
import {test} from 'node:test';

import {base58} from '@scure/base';

import {parseWalletConnectRequest} from '../.bld/app/@lib/wallet-connect-request.js';

const CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const ADDRESS = `Ab${'1'.repeat(41)}`;
const OTHER_ADDRESS = `AB${'1'.repeat(41)}`;
const messageBytes = text => new TextEncoder().encode(text);
const request = (message = messageBytes('Hello from AppKit')) => ({
  topic: 'session',
  params: {
    chainId: CHAIN,
    request: {
      method: 'solana_signMessage',
      params: {pubkey: ADDRESS, message: base58.encode(message)},
    },
  },
});
const session = () => ({
  topic: 'session',
  namespaces: {
    solana: {
      chains: [CHAIN],
      accounts: [`${CHAIN}:${ADDRESS}`],
      methods: ['solana_signMessage'],
      events: [],
    },
  },
});

test('Solana signing preserves original bytes and never uses an EVM digest', () => {
  for (const text of [
    '',
    'Hello from AppKit',
    '登录 Monoid 👋\n',
    ' Leading\ttrailing\r\n ',
  ]) {
    const message = messageBytes(text);
    assert.deepEqual(parseWalletConnectRequest(request(message), session()), {
      method: 'solana_signMessage',
      address: ADDRESS,
      chainId: CHAIN,
      message,
      text,
    });
  }
});

test('nontransaction binary and invisible characters retain exact bytes with hex display', () => {
  for (const message of [
    new Uint8Array([0xff, 0, 0xfe]),
    messageBytes('Hidden\u200b'),
    messageBytes('\ufeffBOM'),
  ]) {
    const parsed = parseWalletConnectRequest(request(message), session());
    assert.deepEqual(parsed.message, message);
    assert.equal(parsed.text, undefined);
  }
});

test('Solana authorization binds topic, method, network, and case-sensitive account together', () => {
  for (const change of ['topic', 'method', 'chain', 'account', 'namespace']) {
    const approved = session();
    const permissions = approved.namespaces.solana;
    if (change === 'topic') approved.topic = 'other';
    if (change === 'method') permissions.methods = [];
    if (change === 'chain')
      permissions.chains = ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'];
    if (change === 'account')
      permissions.accounts = [`${CHAIN}:${OTHER_ADDRESS}`];
    if (change === 'namespace')
      approved.namespaces = {[`${CHAIN}other`]: permissions};
    assert.throws(() => parseWalletConnectRequest(request(), approved), {
      code: 4100,
    });
  }
  const approved = session();
  approved.namespaces = {[CHAIN]: approved.namespaces.solana};
  assert.equal(parseWalletConnectRequest(request(), approved).address, ADDRESS);
});

test('rejects malformed Solana parameters and unsupported chains without guessing encoding', () => {
  const valid = request();
  for (const params of [
    undefined,
    null,
    [],
    {},
    {publicKey: ADDRESS, message: valid.params.request.params.message},
    {pubkey: ADDRESS, message: '0x00'},
    {pubkey: ADDRESS, message: 0},
    {pubkey: '1'.repeat(31), message: ''},
    {pubkey: '1'.repeat(33), message: ''},
  ]) {
    const incoming = request();
    incoming.params.request.params = params;
    assert.throws(() => parseWalletConnectRequest(incoming, session()), {
      code: -32602,
    });
  }
  for (const chainId of ['eip155:1', 'solana:mainnet', `${CHAIN}:extra`]) {
    const incoming = request();
    incoming.params.chainId = chainId;
    assert.throws(() => parseWalletConnectRequest(incoming, session()), {
      code: 4200,
    });
  }
});

test('transaction message bytes cannot bypass transaction review through message signing', () => {
  // Legacy message: one writable signer, a blockhash and no instructions.
  const transactionMessage = new Uint8Array([
    1,
    0,
    0,
    1,
    ...base58.decode(ADDRESS),
    ...new Uint8Array(32).fill(1),
    0,
  ]);
  assert.throws(
    () => parseWalletConnectRequest(request(transactionMessage), session()),
    {
      code: -32602,
      message: 'Use transaction signing for this message.',
    },
  );
});
