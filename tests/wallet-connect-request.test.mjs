import assert from 'node:assert/strict';
import {test} from 'node:test';

import {getBytes, hexlify, toUtf8Bytes} from 'ethers';

const {parseWalletConnectPersonalSign, WalletConnectRequestError} =
  await import('../.bld/app/@lib/wallet-connect-request.js');

const address = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const otherAddress = '0x0000000000000000000000000000000000000001';
const request = (message = '0x48656c6c6f', account = address) => ({
  topic: 'session',
  params: {
    chainId: 'eip155:1',
    request: {method: 'personal_sign', params: [message, account]},
  },
});
const session = (
  namespaces = {
    eip155: {
      chains: ['eip155:1', 'eip155:137'],
      accounts: [`eip155:1:${address}`, `eip155:137:${address}`],
      methods: ['personal_sign'],
      events: [],
    },
  },
) => ({topic: 'session', namespaces});

function assertRequestError(action, code) {
  assert.throws(action, error => {
    assert.ok(error instanceof WalletConnectRequestError);
    assert.equal(error.code, code);
    assert.ok(error.message.length);
    return true;
  });
}

test('parses hex bytes rather than the literal hex string and normalizes the account', () => {
  const result = parseWalletConnectPersonalSign(
    request('0x48656C6C6f', address.toLowerCase()),
    session(),
  );

  assert.deepEqual(result, {
    address,
    chainId: 'eip155:1',
    message: getBytes('0x48656c6c6f'),
    text: 'Hello',
  });
});

test('preserves Unicode, whitespace and empty messages for display and signing', () => {
  for (const text of ['', '登录 Monoid 👋\nMessage', 'First\r\n\tSecond ']) {
    const message = toUtf8Bytes(text);
    const parsed = parseWalletConnectPersonalSign(
      request(hexlify(message)),
      session(),
    );

    assert.deepEqual(parsed.message, message);
    assert.equal(parsed.text, text);
  }
});

test('displays invisible controls and formatting characters as exact hex bytes', () => {
  for (const text of [
    'NUL\u0000',
    'Back\bspace',
    '\uFEFFwith BOM',
    'Hidden\u200B',
    'Direction\u202E',
  ]) {
    const message = toUtf8Bytes(text);
    const parsed = parseWalletConnectPersonalSign(
      request(hexlify(message)),
      session(),
    );

    assert.deepEqual(parsed.message, message);
    assert.equal(parsed.text, undefined);
  }
});

test('keeps non-UTF8 binary messages exact and requires hex display', () => {
  for (const value of ['0xff00fe', '0xc328', '0xe282', '0xedb080']) {
    const parsed = parseWalletConnectPersonalSign(request(value), session());

    assert.deepEqual(parsed.message, getBytes(value));
    assert.equal(parsed.text, undefined);
  }
});

test('supports namespace-wide and chain-scoped session permissions', () => {
  for (const namespaces of [
    {
      eip155: {
        accounts: [`eip155:1:${address.toLowerCase()}`],
        methods: ['personal_sign'],
      },
    },
    {
      'eip155:1': {
        accounts: [`eip155:1:${address}`],
        methods: ['personal_sign'],
      },
    },
  ]) {
    assert.equal(
      parseWalletConnectPersonalSign(request(), session(namespaces)).address,
      address,
    );
  }
});

test('rejects requests for another session or unsupported signing methods and networks', () => {
  const wrongTopic = request();
  wrongTopic.topic = 'another-session';
  assertRequestError(
    () => parseWalletConnectPersonalSign(wrongTopic, session()),
    4100,
  );

  for (const method of [
    'eth_sign',
    'eth_signTypedData_v4',
    'personal_signTypedData',
  ]) {
    const unsupported = request();
    unsupported.params.request.method = method;
    assertRequestError(
      () => parseWalletConnectPersonalSign(unsupported, session()),
      4200,
    );
  }

  for (const chain of [
    'solana:mainnet',
    'eip155:0',
    'eip155:01',
    'eip155:1:extra',
  ]) {
    const unsupported = request();
    unsupported.params.chainId = chain;
    assertRequestError(
      () => parseWalletConnectPersonalSign(unsupported, session()),
      4200,
    );
  }
});

test('requires the chain, method and account to be authorized together', () => {
  for (const namespaces of [
    {},
    {eip155: {accounts: [`eip155:137:${address}`], methods: ['personal_sign']}},
    {
      eip155: {
        accounts: [`eip155:1:${otherAddress}`],
        methods: ['personal_sign'],
      },
    },
    {eip155: {accounts: [`eip155:1:${address}`], methods: ['eth_sign']}},
    {
      eip155: {
        chains: ['eip155:137'],
        accounts: [`eip155:1:${address}`],
        methods: ['personal_sign'],
      },
    },
    {
      'eip155:137': {
        accounts: [`eip155:1:${address}`],
        methods: ['personal_sign'],
      },
    },
    {
      'eip155:1': {accounts: [`eip155:1:${address}`], methods: []},
      'eip155:137': {
        accounts: [`eip155:137:${address}`],
        methods: ['personal_sign'],
      },
    },
  ]) {
    assertRequestError(
      () => parseWalletConnectPersonalSign(request(), session(namespaces)),
      4100,
    );
  }
});

test('rejects malformed parameters without guessing their order or encoding', () => {
  for (const params of [
    undefined,
    null,
    {},
    [],
    ['0x00'],
    ['0x00', address, 'extra'],
    [address, '0x00'],
    ['Hello', address],
    ['48656c6c6f', address],
    ['0x0', address],
    ['0xgg', address],
    ['0X00', address],
    ['0x00', 'example.eth'],
    ['0x00', otherAddress.slice(2)],
    ['0x00', address.replace('E', 'e')],
    [new Uint8Array([0]), address],
    ['0x00', null],
  ]) {
    const invalid = request();
    invalid.params.request.params = params;
    assertRequestError(
      () => parseWalletConnectPersonalSign(invalid, session()),
      -32602,
    );
  }
});
