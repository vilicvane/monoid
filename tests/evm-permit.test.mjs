import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  MaxUint256,
  Wallet,
  ZeroAddress,
  getAddress,
  recoverAddress,
} from 'ethers';

const {getEvmPermit} = await import('../.bld/app/@lib/evm-permit.js');
const {parseEvmTypedData} = await import('../.bld/app/@lib/evm-typed-data.js');

function permit() {
  return {
    types: {
      EIP712Domain: [
        {name: 'name', type: 'string'},
        {name: 'version', type: 'string'},
        {name: 'chainId', type: 'uint256'},
        {name: 'verifyingContract', type: 'address'},
      ],
      Permit: [
        {name: 'owner', type: 'address'},
        {name: 'spender', type: 'address'},
        {name: 'value', type: 'uint256'},
        {name: 'nonce', type: 'uint256'},
        {name: 'deadline', type: 'uint256'},
      ],
    },
    primaryType: 'Permit',
    domain: {
      name: 'USD Coin',
      version: '2',
      chainId: 1,
      verifyingContract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    },
    message: {
      owner: '0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826',
      spender: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      value: '123456789',
      nonce: '7',
      deadline: '1800000000',
    },
  };
}

test('recognizes ERC-2612 amounts and canonical addresses from the signed domain', () => {
  const input = permit();
  const {data} = parseEvmTypedData(input);

  assert.deepEqual(getEvmPermit(data), {
    chainId: 'eip155:1',
    token: getAddress(input.domain.verifyingContract),
    owner: getAddress(input.message.owner),
    spender: getAddress(input.message.spender),
    value: 123456789n,
    nonce: 7n,
    deadline: 1800000000n,
  });
});

test('preserves zero, unlimited and large integer values without number conversion', () => {
  for (const value of ['0', '9007199254740993', MaxUint256.toString()]) {
    const input = permit();
    input.domain.chainId = '9007199254740993';
    input.message.value = value;
    input.message.nonce = value;
    input.message.deadline = value;

    const result = getEvmPermit(parseEvmTypedData(input).data);

    assert.equal(result.chainId, 'eip155:9007199254740993');
    assert.equal(result.value, BigInt(value));
    assert.equal(result.nonce, BigInt(value));
    assert.equal(result.deadline, BigInt(value));
  }
});

test('does not recognize renamed, reordered, extended or differently typed Permit schemas', () => {
  for (const change of [
    input => {
      input.types.Authorization = input.types.Permit;
      delete input.types.Permit;
      input.primaryType = 'Authorization';
    },
    input => input.types.Permit.reverse(),
    input => input.types.Permit.pop(),
    input => {
      input.types.Permit.push({name: 'extra', type: 'uint256'});
      input.message.extra = '1';
    },
    input => (input.types.Permit[2].type = 'uint128'),
    input => {
      input.types.Permit[0].name = 'holder';
      input.message.holder = input.message.owner;
    },
  ]) {
    const input = permit();
    change(input);
    assert.equal(getEvmPermit(parseEvmTypedData(input).data), undefined);
  }
});

test('requires a signed positive chain ID and a nonzero token contract', () => {
  for (const change of [
    input => (input.domain.chainId = 0),
    input => (input.domain.verifyingContract = ZeroAddress),
    ...['chainId', 'verifyingContract'].map(name => input => {
      delete input.domain[name];
      input.types.EIP712Domain = input.types.EIP712Domain.filter(
        field => field.name !== name,
      );
    }),
  ]) {
    const input = permit();
    change(input);
    assert.equal(getEvmPermit(parseEvmTypedData(input).data), undefined);
  }
});

test('leaves DAI-style and Permit2 authorization messages to generic typed-data rendering', () => {
  const dai = permit();
  dai.types.Permit = [
    {name: 'holder', type: 'address'},
    {name: 'spender', type: 'address'},
    {name: 'nonce', type: 'uint256'},
    {name: 'expiry', type: 'uint256'},
    {name: 'allowed', type: 'bool'},
  ];
  dai.message = {
    holder: dai.message.owner,
    spender: dai.message.spender,
    nonce: '7',
    expiry: '1800000000',
    allowed: true,
  };

  const permit2 = permit();
  delete permit2.types.Permit;
  permit2.primaryType = 'PermitSingle';
  permit2.types.PermitDetails = [
    {name: 'token', type: 'address'},
    {name: 'amount', type: 'uint160'},
    {name: 'expiration', type: 'uint48'},
    {name: 'nonce', type: 'uint48'},
  ];
  permit2.types.PermitSingle = [
    {name: 'details', type: 'PermitDetails'},
    {name: 'spender', type: 'address'},
    {name: 'sigDeadline', type: 'uint256'},
  ];
  permit2.message = {
    details: {
      token: permit2.domain.verifyingContract,
      amount: '100',
      expiration: '1800000000',
      nonce: '7',
    },
    spender: permit2.message.spender,
    sigDeadline: '1800000000',
  };

  for (const input of [dai, permit2]) {
    assert.equal(getEvmPermit(parseEvmTypedData(input).data), undefined);
  }
});

test('recognition leaves the original EIP-712 data, digest and recovered signer unchanged', async () => {
  const wallet = new Wallet(`0x${'1'.padStart(64, '0')}`);
  const input = permit();
  input.message.owner = wallet.address;
  input.message.value = MaxUint256.toString();
  const original = structuredClone(input);
  const {data, digest} = parseEvmTypedData(input);
  const normalized = structuredClone(data);
  const signature = await wallet.signTypedData(
    input.domain,
    {Permit: input.types.Permit},
    input.message,
  );

  const result = getEvmPermit(data);

  assert.equal(result.owner, wallet.address);
  assert.equal(recoverAddress(digest, signature), result.owner);
  assert.equal(parseEvmTypedData(data).digest, digest);
  assert.deepEqual(data, normalized);
  assert.deepEqual(input, original);
});

test('recognition also preserves a nonstandard signed domain order', () => {
  const input = permit();
  input.types.EIP712Domain.reverse();
  const {data, digest} = parseEvmTypedData(input);
  const normalized = structuredClone(data);

  assert.ok(getEvmPermit(data));
  assert.deepEqual(data, normalized);
  assert.equal(parseEvmTypedData(data).digest, digest);
});
