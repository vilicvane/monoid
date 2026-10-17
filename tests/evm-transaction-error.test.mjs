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
      ['execution reverted: no details', 'Execution reverted.'],
      ['Too many requests', retry],
      ['Method not found', retry],
      ['Internal error', retry],
      ['upstream request timeout', retry],
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

test('does not surface RPC payloads or detailed ethers validation errors', () => {
  const errors = [
    makeError('missing response from secret RPC URL', 'NETWORK_ERROR', {
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
    assert.equal(formatEvmTransactionError(error), retry);
  }
});

test('keeps short local preparation messages and uses a fallback for unknown errors', () => {
  for (const message of [
    'The RPC uses a different network.',
    'Could not determine transaction fees.',
    'Gas limit is too low.',
    'Insufficient funds for the amount and maximum gas fee.',
  ]) {
    assert.equal(formatEvmTransactionError(new Error(message)), message);
  }

  for (const error of [
    undefined,
    null,
    'unexpected failure',
    {},
    new Error(),
    new Error('x'.repeat(241)),
  ]) {
    assert.equal(formatEvmTransactionError(error), retry);
  }
});
