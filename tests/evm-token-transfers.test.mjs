import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Interface, ZeroAddress, getAddress} from 'ethers';

const {getEvmTokenChanges, parseEvmTokenTransfers} = await import(
  '../.bld/app/@lib/evm-token-transfers.js'
);

const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const OTHER_TOKEN = '0x1111111111111111111111111111111111111111';
const SIGNER = '0x1234567890abcdef1234567890abcdef12345678';
const PEER = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const EVENTS = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
]);

function transfer(from, to, value, address = TOKEN, index = 0) {
  return {
    address,
    index,
    ...EVENTS.encodeEventLog(EVENTS.getEvent('Transfer'), [from, to, value]),
  };
}

test('decodes every standard transfer in receipt order with checksummed addresses and exact amounts', () => {
  const maximum = (1n << 256n) - 1n;
  const logs = [
    transfer(SIGNER, PEER, maximum, TOKEN, 3),
    transfer(OTHER, PEER, 0n, OTHER_TOKEN, 8),
    transfer(ZeroAddress, SIGNER, 12n, TOKEN, 9),
    transfer(SIGNER, ZeroAddress, 5n, TOKEN, 10),
  ];

  assert.deepEqual(parseEvmTokenTransfers({status: 1, logs}), [
    {
      tokenAddress: getAddress(TOKEN),
      from: getAddress(SIGNER),
      to: PEER,
      value: maximum,
      logIndex: 3,
    },
    {
      tokenAddress: OTHER_TOKEN,
      from: OTHER,
      to: PEER,
      value: 0n,
      logIndex: 8,
    },
    {
      tokenAddress: getAddress(TOKEN),
      from: ZeroAddress,
      to: getAddress(SIGNER),
      value: 12n,
      logIndex: 9,
    },
    {
      tokenAddress: getAddress(TOKEN),
      from: getAddress(SIGNER),
      to: ZeroAddress,
      value: 5n,
      logIndex: 10,
    },
  ]);
});

test('ignores approvals, ERC-721 transfers and malformed event encodings without losing valid transfers', () => {
  const valid = transfer(SIGNER, PEER, 42n);
  const approval = {
    address: TOKEN,
    index: 1,
    ...EVENTS.encodeEventLog(EVENTS.getEvent('Approval'), [SIGNER, PEER, 42n]),
  };
  const logs = [
    approval,
    {...valid, topics: [...valid.topics, valid.data], data: '0x'},
    {...valid, topics: [...valid.topics, valid.data]},
    {...valid, topics: valid.topics.slice(0, 2)},
    {...valid, topics: [valid.topics[0], '0x12', valid.topics[2]]},
    {
      ...valid,
      topics: [
        valid.topics[0],
        `0x1${valid.topics[1].slice(3)}`,
        valid.topics[2],
      ],
    },
    {...valid, data: '0x'},
    {...valid, data: `${valid.data}00`},
    {...valid, data: `0x${'z'.repeat(64)}`},
    {...valid, address: '0x12'},
    valid,
  ];

  assert.deepEqual(
    parseEvmTokenTransfers({status: 1, logs}),
    parseEvmTokenTransfers({status: 1, logs: [valid]}),
  );
});

test('failed or unconfirmed receipts cannot produce token changes', () => {
  const logs = [transfer(SIGNER, PEER, 42n)];
  assert.deepEqual(parseEvmTokenTransfers({status: 0, logs}), []);
  assert.deepEqual(parseEvmTokenTransfers({status: null, logs}), []);
});

test('nets signer transfers by token across mint, burn and internal transfers without counting unrelated accounts', () => {
  const large = 1n << 200n;
  const transfers = parseEvmTokenTransfers({
    status: 1,
    logs: [
      transfer(OTHER, PEER, 900n, OTHER_TOKEN),
      transfer(SIGNER, PEER, large),
      transfer(PEER, SIGNER, large - 7n),
      transfer(ZeroAddress, SIGNER, 10n),
      transfer(SIGNER, ZeroAddress, 5n),
      transfer(PEER, SIGNER, 15n, OTHER_TOKEN),
    ],
  });

  // Equality is case-insensitive, including grouping multiple logs for a token.
  transfers[2].tokenAddress = TOKEN;
  assert.deepEqual(getEvmTokenChanges(transfers, SIGNER), [
    {tokenAddress: getAddress(TOKEN), value: -2n},
    {tokenAddress: OTHER_TOKEN, value: 15n},
  ]);
  assert.deepEqual(getEvmTokenChanges(transfers, getAddress(SIGNER)), [
    {tokenAddress: getAddress(TOKEN), value: -2n},
    {tokenAddress: OTHER_TOKEN, value: 15n},
  ]);
});

test('retains touched tokens with zero net change while self-transfers cancel out', () => {
  const transfers = parseEvmTokenTransfers({
    status: 1,
    logs: [
      transfer(SIGNER, SIGNER, 100n),
      transfer(SIGNER, PEER, 7n, OTHER_TOKEN),
      transfer(PEER, SIGNER, 7n, OTHER_TOKEN),
    ],
  });

  assert.deepEqual(getEvmTokenChanges(transfers, SIGNER), [
    {tokenAddress: getAddress(TOKEN), value: 0n},
    {tokenAddress: OTHER_TOKEN, value: 0n},
  ]);
  assert.deepEqual(getEvmTokenChanges(transfers, OTHER), []);
  assert.deepEqual(getEvmTokenChanges([], SIGNER), []);
});
