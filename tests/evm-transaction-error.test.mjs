import assert from 'node:assert/strict';
import {test} from 'node:test';

import {AbiCoder, JsonRpcProvider, makeError} from 'ethers';

const {formatEvmTransactionError} = await import(
  '../.bld/app/@lib/evm-transaction-error.js'
);

const retry = 'Could not prepare this transaction. Try again.';
const to = '0x1111111111111111111111111111111111111111';

test('decodes standard revert messages, panic codes and unknown error selectors', () => {
  const coder = AbiCoder.defaultAbiCoder();

  for (const [data, message] of [
    [
      `0x08c379a0${coder.encode(['string'], ['Allowance exceeded']).slice(2)}`,
      'Allowance exceeded',
    ],
    [
      `0x4e487b71${coder.encode(['uint256'], [0x11]).slice(2)}`,
      'Panic (0x11).',
    ],
    ['0xdeadbeef' + '00'.repeat(32), 'Custom error (0xdeadbeef).'],
    ['0x', 'Execution reverted.'],
    ['0x08c379a000', 'Execution reverted.'],
  ]) {
    const error = AbiCoder.getBuiltinCallException('estimateGas', {to}, data);

    assert.equal(formatEvmTransactionError(error), message);
  }
});

test('uses a reliable CALL_EXCEPTION reason when encoded revert data is absent', () => {
  const error = AbiCoder.getBuiltinCallException('estimateGas', {to}, null);
  error.reason = 'Only the owner may call this function.';

  assert.equal(formatEvmTransactionError(error), error.reason);
});

test('formats real ethers RPC errors without treating unavailable estimation as a revert', () => {
  const provider = new JsonRpcProvider();
  const payload = {
    id: 1,
    jsonrpc: '2.0',
    method: 'eth_estimateGas',
    params: [{to, data: '0x12345678'}],
  };

  try {
    for (const [message, expected] of [
      ['insufficient funds for gas * price + value', 'Insufficient funds.'],
      ['intrinsic gas too low: have 21000 want 55000', 'Gas limit is too low.'],
      ['out of gas', 'Gas limit is too low.'],
      [
        'max fee per gas less than block base fee: maxFeePerGas: 10000000, baseFee: 20000000',
        'Max. fee per gas is below the current base fee.',
      ],
      [
        'failed with 159967 gas: max fee per gas less than block base fee: maxFeePerGas: 10000000, baseFee: 20000000',
        'Max. fee per gas is below the current base fee.',
      ],
      ['execution reverted', 'Execution reverted.'],
      [
        'execution reverted: denied by policy',
        'execution reverted: denied by policy',
      ],
      ['Too many requests', 'Too many requests'],
      ['Method not found', 'Method not found'],
      ['Internal error', 'Internal error'],
      ['upstream request timeout', 'upstream request timeout'],
    ]) {
      const error = provider.getRpcError(payload, {
        id: 1,
        error: {
          code: message === 'Method not found' ? -32601 : -32000,
          message,
        },
      });

      assert.equal(formatEvmTransactionError(error), expected);
    }
  } finally {
    provider.destroy();
  }
});

test('uses ethers short messages without appending serialized request payloads', () => {
  const errors = [
    makeError('network unavailable', 'NETWORK_ERROR', {
      event: 'noNetwork',
    }),
    makeError('invalid value', 'INVALID_ARGUMENT', {
      argument: 'transaction',
      value: {data: '0xprivate'},
    }),
    makeError('unknown RPC failure with full request', 'UNKNOWN_ERROR', {
      payload: {data: 'not-for-display'},
    }),
  ];

  for (const error of errors) {
    assert.equal(formatEvmTransactionError(error), error.shortMessage);
  }
});

test('preserves RPC messages outside CALL_EXCEPTION and with empty revert data', () => {
  const provider = new JsonRpcProvider();
  try {
    for (const method of ['eth_getBalance', 'eth_estimateGas']) {
      const message = 'execution reverted: denied by policy';
      const error = provider.getRpcError(
        {id: 1, jsonrpc: '2.0', method, params: [{to}]},
        {id: 1, error: {code: -32000, message, data: '0x'}},
      );
      assert.equal(formatEvmTransactionError(error), message);
    }
  } finally {
    provider.destroy();
  }
});

test('keeps original messages regardless of length or error code', () => {
  for (const message of [
    'The RPC uses a different network.',
    'Could not determine transaction fees.',
    'Gas limit is too low.',
    'Insufficient funds for the amount and maximum gas fee.',
    'x'.repeat(300),
  ]) {
    assert.equal(formatEvmTransactionError(new Error(message)), message);
    assert.equal(
      formatEvmTransactionError(
        Object.assign(new Error(message), {code: 'RPC_ERROR'}),
      ),
      message,
    );
    assert.equal(formatEvmTransactionError(message), message);
  }
});

test('falls through empty or malformed fields and uses generic text only without a message', () => {
  assert.equal(
    formatEvmTransactionError({
      info: {error: {message: '   '}},
      error: {message: 42},
      shortMessage: '  connection closed  ',
      message: 'connection closed (request details)',
    }),
    'connection closed',
  );
  for (const error of [
    undefined,
    null,
    '   ',
    {},
    new Error(),
    {message: 42},
  ]) {
    assert.equal(formatEvmTransactionError(error), retry);
  }
});
