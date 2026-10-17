import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Interface, MaxUint256, getAddress} from 'ethers';

const {getLatestEvmTokenApprovals, parseEvmTokenApprovals} = await import(
  '../.bld/app/@lib/evm-token-approvals.js'
);

const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const OTHER_TOKEN = '0x1111111111111111111111111111111111111111';
const OWNER = '0x1234567890abcdef1234567890abcdef12345678';
const OTHER_OWNER = '0x2222222222222222222222222222222222222222';
const SPENDER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const OTHER_SPENDER = '0x3333333333333333333333333333333333333333';
const EVENTS = new Interface([
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

function approval(owner, spender, value, address = TOKEN, index = 0) {
  return {
    address,
    index,
    ...EVENTS.encodeEventLog(EVENTS.getEvent('Approval'), [
      owner,
      spender,
      value,
    ]),
  };
}

test('decodes approvals in receipt order with checksummed addresses and exact zero or unlimited amounts', () => {
  const logs = [
    approval(OWNER, SPENDER, MaxUint256, TOKEN, 3),
    approval(OWNER, SPENDER, 0n, TOKEN, 5),
    approval(OTHER_OWNER, OTHER_SPENDER, 1n << 200n, OTHER_TOKEN, 8),
  ];

  assert.deepEqual(parseEvmTokenApprovals({status: 1, logs}), [
    {
      tokenAddress: getAddress(TOKEN),
      owner: getAddress(OWNER),
      spender: getAddress(SPENDER),
      value: MaxUint256,
      logIndex: 3,
    },
    {
      tokenAddress: getAddress(TOKEN),
      owner: getAddress(OWNER),
      spender: getAddress(SPENDER),
      value: 0n,
      logIndex: 5,
    },
    {
      tokenAddress: OTHER_TOKEN,
      owner: OTHER_OWNER,
      spender: OTHER_SPENDER,
      value: 1n << 200n,
      logIndex: 8,
    },
  ]);
});

test('ignores ERC-721 approvals, ApprovalForAll, transfers and malformed event encodings', () => {
  const valid = approval(OWNER, SPENDER, 42n);
  const logs = [
    {
      address: TOKEN,
      index: 1,
      ...EVENTS.encodeEventLog(EVENTS.getEvent('ApprovalForAll'), [
        OWNER,
        SPENDER,
        true,
      ]),
    },
    {
      address: TOKEN,
      index: 2,
      ...EVENTS.encodeEventLog(EVENTS.getEvent('Transfer'), [
        OWNER,
        SPENDER,
        42n,
      ]),
    },
    {...valid, topics: [...valid.topics, valid.data], data: '0x'},
    {...valid, topics: [...valid.topics, valid.data]},
    {...valid, topics: valid.topics.slice(0, 2)},
    {...valid, topics: [valid.topics[0], '0x12', valid.topics[2]]},
    {
      ...valid,
      topics: [
        valid.topics[0],
        valid.topics[1],
        `0x1${valid.topics[2].slice(3)}`,
      ],
    },
    {...valid, data: '0x'},
    {...valid, data: `${valid.data}00`},
    {...valid, data: `0x${'z'.repeat(64)}`},
    {...valid, address: '0x12'},
    valid,
  ];

  assert.deepEqual(
    parseEvmTokenApprovals({status: 1, logs}),
    parseEvmTokenApprovals({status: 1, logs: [valid]}),
  );
});

test('failed or unconfirmed receipts cannot produce approvals', () => {
  const logs = [approval(OWNER, SPENDER, 42n)];
  assert.deepEqual(parseEvmTokenApprovals({status: 0, logs}), []);
  assert.deepEqual(parseEvmTokenApprovals({status: null, logs}), []);
});

test('keeps the last value for each owner token and spender without adding values or changing first-seen group order', () => {
  const approvals = parseEvmTokenApprovals({
    status: 1,
    logs: [
      approval(OWNER, SPENDER, 5n, TOKEN, 1),
      approval(OWNER, OTHER_SPENDER, 8n, TOKEN, 2),
      approval(OWNER, SPENDER, 3n, OTHER_TOKEN, 3),
      approval(OTHER_OWNER, SPENDER, 12n, TOKEN, 4),
      approval(OWNER, SPENDER, MaxUint256, TOKEN, 5),
      approval(OWNER, OTHER_SPENDER, 0n, TOKEN, 6),
    ],
  });

  approvals[4] = {
    ...approvals[4],
    tokenAddress: TOKEN,
    owner: OWNER,
    spender: SPENDER,
  };
  const expected = [approvals[4], approvals[5], approvals[2]];
  assert.deepEqual(getLatestEvmTokenApprovals(approvals, OWNER), expected);
  assert.deepEqual(
    getLatestEvmTokenApprovals(approvals, getAddress(OWNER)),
    expected,
  );
  assert.deepEqual(getLatestEvmTokenApprovals(approvals, OTHER_OWNER), [
    approvals[3],
  ]);
  assert.deepEqual(getLatestEvmTokenApprovals(approvals, OTHER_SPENDER), []);
});

test('retains revocation after an unlimited approval and handles an empty receipt', () => {
  const approvals = parseEvmTokenApprovals({
    status: 1,
    logs: [approval(OWNER, SPENDER, MaxUint256), approval(OWNER, SPENDER, 0n)],
  });

  assert.deepEqual(getLatestEvmTokenApprovals(approvals, OWNER), [
    approvals[1],
  ]);
  assert.deepEqual(parseEvmTokenApprovals({status: 1, logs: []}), []);
  assert.deepEqual(getLatestEvmTokenApprovals([], OWNER), []);
});
