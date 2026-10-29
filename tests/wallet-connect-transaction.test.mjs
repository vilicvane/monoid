import assert from 'node:assert/strict';
import {test} from 'node:test';

const {parseWalletConnectTransactionRequest, WalletConnectRequestError} =
  await import('../.bld/app/@lib/wallet-connect-request.js');

const address = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const recipient = '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF';
const slot = `0x${'ab'.repeat(32)}`;
const request = (transaction = {}) => ({
  topic: 'session',
  params: {
    chainId: 'eip155:1',
    request: {
      method: 'eth_sendTransaction',
      params: [
        {
          from: address.toLowerCase(),
          to: recipient.toLowerCase(),
          ...transaction,
        },
      ],
    },
  },
});
const session = (
  namespaces = {
    eip155: {
      chains: ['eip155:1', 'eip155:137'],
      accounts: [`eip155:1:${address}`, `eip155:137:${address}`],
      methods: ['eth_sendTransaction'],
      events: [],
    },
  },
) => ({topic: 'session', namespaces});

function assertRequestError(action, code) {
  assert.throws(action, error => {
    assert.ok(error instanceof WalletConnectRequestError);
    if (code !== undefined) assert.equal(error.code, code);
    assert.ok(error.message.length);
    return true;
  });
}

test('normalizes a transfer without inventing fees, nonce or transaction type', () => {
  const incoming = request();
  const original = structuredClone(incoming);

  assert.deepEqual(parseWalletConnectTransactionRequest(incoming, session()), {
    method: 'eth_sendTransaction',
    address,
    chainId: 'eip155:1',
    transaction: {chainId: 1n, to: recipient, data: '0x', value: 0n},
  });
  assert.deepEqual(incoming, original);
});

test('preserves exact legacy transaction quantities and converts gas to gasLimit', () => {
  const {transaction} = parseWalletConnectTransactionRequest(
    request({
      chainId: '0x1',
      type: 0,
      value: '9007199254740993',
      gas: '0x5208',
      gasPrice: '0x3b9aca00',
      nonce: '0x2',
      data: '0xAABB',
    }),
    session(),
  );

  assert.deepEqual(transaction, {
    chainId: 1n,
    type: 0,
    to: recipient,
    data: '0xaabb',
    value: 9007199254740993n,
    gasLimit: 21000n,
    gasPrice: 1000000000n,
    nonce: 2,
  });
});

test('preserves a Sepolia payable contract request using gasLimit and EIP-1559 fees', () => {
  const data = `0x3593564c${'00'.repeat(96)}`;
  const incoming = request({
    chainId: '0xaa36a7',
    type: '0x2',
    data,
    value: '0x38d7ea4c68000',
    gasLimit: '0x493e0',
    maxFeePerGas: '0x77359400',
    maxPriorityFeePerGas: '0x3b9aca00',
  });
  incoming.params.chainId = 'eip155:11155111';
  const original = structuredClone(incoming);

  assert.deepEqual(
    parseWalletConnectTransactionRequest(
      incoming,
      session({
        eip155: {
          chains: ['eip155:11155111'],
          accounts: [`eip155:11155111:${address}`],
          methods: ['eth_sendTransaction'],
          events: [],
        },
      }),
    ),
    {
      method: 'eth_sendTransaction',
      address,
      chainId: 'eip155:11155111',
      transaction: {
        chainId: 11155111n,
        type: 2,
        to: recipient,
        data,
        value: 1000000000000000n,
        gasLimit: 300000n,
        maxFeePerGas: 2000000000n,
        maxPriorityFeePerGas: 1000000000n,
      },
    },
  );
  assert.deepEqual(incoming, original);
});

test('accepts either gas alias and prefers gas when both are present', () => {
  for (const fields of [
    {gas: '0x5208'},
    {gasLimit: '0x5208'},
    {gas: undefined, gasLimit: '0x5208'},
    {gas: '21000', gasLimit: '0x5208'},
    {gas: '0x5208', gasLimit: 21000},
    {gas: '0x5208', gasLimit: 21001},
    {gas: '0x5208', gasLimit: 0},
  ]) {
    const {transaction} = parseWalletConnectTransactionRequest(
      request(fields),
      session(),
    );
    assert.equal(transaction.gasLimit, 21000n);
    assert.equal(transaction.gas, undefined);
  }

  for (const gas of [0, '0x0']) {
    const {transaction} = parseWalletConnectTransactionRequest(
      request({gas, gasLimit: '0x5208'}),
      session(),
    );
    assert.equal(transaction.gasLimit, 0n);
  }
});

test('ignores an unselected gasLimit but still rejects an invalid selected gas value', () => {
  for (const value of [null, -1, Number.MAX_SAFE_INTEGER + 1, 1n << 256n]) {
    const {transaction} = parseWalletConnectTransactionRequest(
      request({gas: 21000, gasLimit: value}),
      session(),
    );
    assert.equal(transaction.gasLimit, 21000n);

    for (const fields of [
      {gas: value, gasLimit: 21000},
      {gas: undefined, gasLimit: value},
    ]) {
      assertRequestError(
        () => parseWalletConnectTransactionRequest(request(fields), session()),
        -32602,
      );
    }
  }
});

test('preserves access-list and EIP-1559 transactions with normalized addresses and storage keys', () => {
  for (const type of [1, 2]) {
    for (const accessList of [
      [
        {
          address: recipient.toLowerCase(),
          storageKeys: [slot.toUpperCase().replace('0X', '0x')],
        },
      ],
      [[recipient.toLowerCase(), [slot]]],
    ]) {
      const fees =
        type === 1
          ? {gasPrice: '0x3b9aca00'}
          : {maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00'};
      const {transaction} = parseWalletConnectTransactionRequest(
        request({type: `0x${type}`, gas: 30000, nonce: 0, accessList, ...fees}),
        session(),
      );

      assert.equal(transaction.type, type);
      assert.equal(transaction.gasLimit, 30000n);
      assert.equal(transaction.nonce, 0);
      assert.deepEqual(transaction.accessList, [
        {address: recipient, storageKeys: [slot]},
      ]);
      if (type === 1) {
        assert.equal(transaction.gasPrice, 1000000000n);
      } else {
        assert.equal(transaction.maxFeePerGas, 2000000000n);
        assert.equal(transaction.maxPriorityFeePerGas, 1000000000n);
      }
    }
  }
});

test('does not require an explicit transaction type when fees or access lists are present', () => {
  for (const transaction of [
    {gasPrice: '0x1'},
    {maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1'},
    {accessList: []},
  ]) {
    const parsed = parseWalletConnectTransactionRequest(
      request(transaction),
      session(),
    );
    assert.equal(parsed.transaction.type, undefined);
  }
});

test('accepts contract deployment only when an omitted recipient has nonempty creation data', () => {
  const incoming = request({data: '0x60006000'});
  delete incoming.params.request.params[0].to;

  const {transaction} = parseWalletConnectTransactionRequest(
    incoming,
    session(),
  );
  assert.equal(transaction.to, null);
  assert.equal(transaction.data, '0x60006000');

  for (const data of [undefined, '0x']) {
    incoming.params.request.params[0].data = data;
    assertRequestError(
      () => parseWalletConnectTransactionRequest(incoming, session()),
      -32602,
    );
  }
});

test('accepts data or input without changing bytes and rejects conflicting aliases', () => {
  for (const fields of [
    {data: '0xAABB'},
    {input: '0xAABB'},
    {data: '0xAABB', input: '0xaabb'},
  ]) {
    const {transaction} = parseWalletConnectTransactionRequest(
      request(fields),
      session(),
    );
    assert.equal(transaction.data, '0xaabb');
    assert.equal(transaction.input, undefined);
  }

  for (const fields of [
    {data: '0x', input: '0x00'},
    {data: '0xaa', input: '0xbb'},
  ]) {
    assertRequestError(
      () => parseWalletConnectTransactionRequest(request(fields), session()),
      -32602,
    );
  }
});

test('requires a supplied transaction chain ID to match the authorized request chain', () => {
  for (const chainId of [1, '1', '0x1']) {
    const {transaction} = parseWalletConnectTransactionRequest(
      request({chainId}),
      session(),
    );
    assert.equal(transaction.chainId, 1n);
  }

  for (const chainId of [0, 137, '0x89']) {
    assertRequestError(
      () => parseWalletConnectTransactionRequest(request({chainId}), session()),
      -32602,
    );
  }

  const incoming = request({chainId: '0x89'});
  incoming.params.chainId = 'eip155:137';
  const parsed = parseWalletConnectTransactionRequest(incoming, session());
  assert.equal(parsed.chainId, 'eip155:137');
  assert.equal(parsed.transaction.chainId, 137n);
});

test('supports namespace-wide and chain-scoped permissions without combining unrelated authorizations', () => {
  for (const namespaces of [
    {
      eip155: {
        accounts: [`eip155:1:${address.toLowerCase()}`],
        methods: ['eth_sendTransaction'],
      },
    },
    {
      'eip155:1': {
        accounts: [`eip155:1:${address}`],
        methods: ['eth_sendTransaction'],
      },
    },
  ]) {
    assert.equal(
      parseWalletConnectTransactionRequest(request(), session(namespaces))
        .address,
      address,
    );
  }

  for (const namespaces of [
    {},
    {
      eip155: {
        accounts: [`eip155:137:${address}`],
        methods: ['eth_sendTransaction'],
      },
    },
    {
      eip155: {
        accounts: [`eip155:1:${recipient}`],
        methods: ['eth_sendTransaction'],
      },
    },
    {eip155: {accounts: [`eip155:1:${address}`], methods: ['personal_sign']}},
    {
      eip155: {
        chains: ['eip155:137'],
        accounts: [`eip155:1:${address}`],
        methods: ['eth_sendTransaction'],
      },
    },
    {
      'eip155:1': {accounts: [`eip155:1:${address}`], methods: []},
      'eip155:137': {
        accounts: [`eip155:137:${address}`],
        methods: ['eth_sendTransaction'],
      },
    },
  ]) {
    assertRequestError(
      () =>
        parseWalletConnectTransactionRequest(request(), session(namespaces)),
      4100,
    );
  }
});

test('rejects a different session, unsupported methods and malformed network identifiers', () => {
  const wrongTopic = request();
  wrongTopic.topic = 'another-session';
  assertRequestError(
    () => parseWalletConnectTransactionRequest(wrongTopic, session()),
    4100,
  );

  for (const method of [
    'personal_sign',
    'eth_signTransaction',
    'eth_sendRawTransaction',
  ]) {
    const incoming = request();
    incoming.params.request.method = method;
    assertRequestError(
      () => parseWalletConnectTransactionRequest(incoming, session()),
      4200,
    );
  }

  for (const chainId of [
    'solana:mainnet',
    'eip155:0',
    'eip155:01',
    'eip155:1:extra',
  ]) {
    const incoming = request();
    incoming.params.chainId = chainId;
    assertRequestError(
      () => parseWalletConnectTransactionRequest(incoming, session()),
      4200,
    );
  }
});

test('rejects malformed params, from and to instead of guessing accounts or ENS names', () => {
  for (const params of [
    undefined,
    null,
    {},
    [],
    [null],
    [address],
    [{from: address}, {}],
  ]) {
    const incoming = request();
    incoming.params.request.params = params;
    assertRequestError(
      () => parseWalletConnectTransactionRequest(incoming, session()),
      -32602,
    );
  }

  for (const transaction of [
    {from: undefined},
    {from: null},
    {from: 'example.eth'},
    {from: address.replace('E', 'e')},
    {to: ''},
    {to: 'example.eth'},
    {to: recipient.slice(2)},
    {to: recipient.replace('B', 'b')},
  ]) {
    assertRequestError(
      () =>
        parseWalletConnectTransactionRequest(request(transaction), session()),
      -32602,
    );
  }
});

test('rejects unsafe, fractional and negative numeric quantities rather than rounding or coercing', () => {
  for (const field of [
    'value',
    'gas',
    'gasLimit',
    'gasPrice',
    'maxFeePerGas',
    'maxPriorityFeePerGas',
    'nonce',
    'chainId',
    'type',
  ]) {
    for (const value of [
      Number.MAX_SAFE_INTEGER + 1,
      -1,
      1.5,
      '-1',
      true,
      null,
      '',
    ]) {
      assertRequestError(
        () =>
          parseWalletConnectTransactionRequest(
            request({[field]: value}),
            session(),
          ),
        -32602,
      );
    }
  }

  for (const nonce of ['9007199254740992', '0x20000000000000']) {
    assertRequestError(
      () => parseWalletConnectTransactionRequest(request({nonce}), session()),
      -32602,
    );
  }
});

test('rejects legacy and EIP-1559 fee conflicts including zero-valued fields', () => {
  for (const fees of [
    {gasPrice: '0x1', maxFeePerGas: '0x2'},
    {gasPrice: '0x0', maxPriorityFeePerGas: '0x0'},
    {type: 0, maxFeePerGas: '0x2'},
    {type: 1, maxPriorityFeePerGas: '0x1'},
    {type: 2, gasPrice: '0x1'},
  ]) {
    assertRequestError(
      () => parseWalletConnectTransactionRequest(request(fees), session()),
      -32602,
    );
  }
});

test('rejects unsupported transaction fields and types instead of silently omitting signing data', () => {
  for (const fields of [
    {extra: 'ignored'},
    {blobVersionedHashes: [`0x01${'00'.repeat(31)}`]},
    {blobs: []},
    {maxFeePerBlobGas: '0x1'},
    {authorizationList: []},
    {type: 3},
    {type: '0x4'},
  ]) {
    assertRequestError(
      () => parseWalletConnectTransactionRequest(request(fields), session()),
      -32602,
    );
  }
});

test('preserves the transaction validation reason in invalid request errors', () => {
  for (const [fields, message] of [
    [{extra: 'ignored'}, 'Unsupported transaction field.'],
    [{chainId: '0x89'}, 'The transaction uses a different network.'],
    [{gasLimit: 1n << 256n}, 'Transaction quantity is too large.'],
  ]) {
    assert.throws(
      () => parseWalletConnectTransactionRequest(request(fields), session()),
      error => {
        assert.ok(error instanceof WalletConnectRequestError);
        assert.equal(error.code, -32602);
        assert.equal(error.message, message);
        return true;
      },
    );
  }
});

test('rejects malformed call data and access lists', () => {
  for (const fields of [
    {data: '0x0'},
    {data: '0xgg'},
    {input: 'hello'},
    {data: ['0x00']},
    {accessList: 'invalid'},
    {accessList: [{address: 'example.eth', storageKeys: [slot]}]},
    {accessList: [{address: recipient, storageKeys: ['0x01']}]},
  ]) {
    assertRequestError(
      () => parseWalletConnectTransactionRequest(request(fields), session()),
      -32602,
    );
  }
});
