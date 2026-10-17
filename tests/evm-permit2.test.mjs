import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  MaxUint256,
  Wallet,
  ZeroAddress,
  getAddress,
  recoverAddress,
} from 'ethers';

const {getEvmPermit2} = await import('../.bld/app/@lib/evm-permit2.js');
const {parseEvmTypedData} = await import('../.bld/app/@lib/evm-typed-data.js');

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const ZKSYNC_PERMIT2 = '0x0000000000225e31D15943971F47aD3022F714Fa';
const MAX_UINT160 = (2n ** 160n - 1n).toString();
const MAX_UINT48 = (2n ** 48n - 1n).toString();

function permit(batch = false) {
  const primaryType = batch ? 'PermitBatch' : 'PermitSingle';
  const detail = {
    token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    amount: '250000000',
    expiration: '1800000000',
    nonce: '7',
  };

  return {
    types: {
      EIP712Domain: [
        {name: 'name', type: 'string'},
        {name: 'chainId', type: 'uint256'},
        {name: 'verifyingContract', type: 'address'},
      ],
      [primaryType]: [
        {name: 'details', type: batch ? 'PermitDetails[]' : 'PermitDetails'},
        {name: 'spender', type: 'address'},
        {name: 'sigDeadline', type: 'uint256'},
      ],
      PermitDetails: [
        {name: 'token', type: 'address'},
        {name: 'amount', type: 'uint160'},
        {name: 'expiration', type: 'uint48'},
        {name: 'nonce', type: 'uint48'},
      ],
    },
    primaryType,
    domain: {
      name: 'Permit2',
      chainId: 1,
      verifyingContract: PERMIT2,
    },
    message: {
      details: batch ? [detail] : detail,
      spender: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      sigDeadline: '1790000000',
    },
  };
}

test('recognizes the single allowance with checksum addresses and typed field paths', () => {
  const input = permit();

  assert.deepEqual(getEvmPermit2(parseEvmTypedData(input).data), {
    chainId: 'eip155:1',
    spender: getAddress(input.message.spender),
    sigDeadline: 1790000000n,
    details: [
      {
        path: '0',
        token: getAddress(input.message.details.token),
        amount: 250000000n,
        expiration: 1800000000n,
        nonce: 7n,
      },
    ],
  });
});

test('preserves batch order, repeated tokens and empty batches', () => {
  const input = permit(true);
  const first = input.message.details[0];
  input.message.details.push(
    {...first, token: '0x1111111111111111111111111111111111111111'},
    {...first, amount: '0', nonce: '8'},
  );

  const result = getEvmPermit2(parseEvmTypedData(input).data);

  assert.deepEqual(
    result.details.map(detail => detail.path),
    ['0.0', '0.1', '0.2'],
  );
  assert.deepEqual(
    result.details.map(({token, amount, nonce}) => ({token, amount, nonce})),
    input.message.details.map(({token, amount, nonce}) => ({
      token: getAddress(token),
      amount: BigInt(amount),
      nonce: BigInt(nonce),
    })),
  );

  input.message.details = [];
  assert.deepEqual(getEvmPermit2(parseEvmTypedData(input).data).details, []);
});

test('preserves zero, maximum values and chain IDs without number conversion', () => {
  for (const batch of [false, true]) {
    for (const maximum of [false, true]) {
      const input = permit(batch);
      const detail = batch ? input.message.details[0] : input.message.details;
      input.domain.chainId = '9007199254740993';
      input.message.sigDeadline = maximum ? MaxUint256.toString() : '0';
      Object.assign(detail, {
        token: ZeroAddress,
        amount: maximum ? MAX_UINT160 : '0',
        expiration: maximum ? MAX_UINT48 : '0',
        nonce: maximum ? MAX_UINT48 : '0',
      });

      const result = getEvmPermit2(parseEvmTypedData(input).data);

      assert.equal(result.chainId, 'eip155:9007199254740993');
      assert.equal(result.sigDeadline, BigInt(input.message.sigDeadline));
      assert.equal(result.details[0].token, ZeroAddress);
      assert.equal(result.details[0].amount, BigInt(detail.amount));
      assert.equal(result.details[0].expiration, BigInt(detail.expiration));
      assert.equal(result.details[0].nonce, BigInt(detail.nonce));
    }
  }
});

test('matches the canonical contract address for the signed chain including zkSync', () => {
  for (const chainId of [1, 10, 324, 42161, 8453]) {
    for (const contract of [PERMIT2, ZKSYNC_PERMIT2, ZeroAddress]) {
      const input = permit();
      input.domain.chainId = chainId;
      input.domain.verifyingContract = contract.toLowerCase();

      const result = getEvmPermit2(parseEvmTypedData(input).data);
      const expected = chainId === 324 ? ZKSYNC_PERMIT2 : PERMIT2;
      assert.equal(!!result, contract === expected);
      if (result) assert.equal(result.chainId, `eip155:${chainId}`);
    }
  }
});

test('rejects unsigned, reordered, extended or incorrectly named Permit2 domains', () => {
  for (const change of [
    input => (input.domain.name = 'permit2'),
    input => (input.domain.chainId = 0),
    input => input.types.EIP712Domain.reverse(),
    input => {
      input.domain.version = '1';
      input.types.EIP712Domain.splice(1, 0, {name: 'version', type: 'string'});
    },
    input => {
      input.domain.salt = `0x${'00'.repeat(32)}`;
      input.types.EIP712Domain.push({name: 'salt', type: 'bytes32'});
    },
    ...['name', 'chainId', 'verifyingContract'].map(name => input => {
      delete input.domain[name];
      input.types.EIP712Domain = input.types.EIP712Domain.filter(
        field => field.name !== name,
      );
    }),
  ]) {
    const input = permit();
    change(input);
    assert.equal(getEvmPermit2(parseEvmTypedData(input).data), undefined);
  }
});

test('does not label renamed, reordered, extended or differently typed structures as Permit2', () => {
  for (const batch of [false, true]) {
    for (const change of [
      input => {
        input.types.CustomPermit = input.types[input.primaryType];
        delete input.types[input.primaryType];
        input.primaryType = 'CustomPermit';
      },
      input => input.types[input.primaryType].reverse(),
      input => input.types[input.primaryType].pop(),
      input => {
        input.types[input.primaryType].push({name: 'witness', type: 'bytes32'});
        input.message.witness = `0x${'00'.repeat(32)}`;
      },
      input => (input.types[input.primaryType][2].type = 'uint48'),
      input => {
        input.types[input.primaryType][1].name = 'recipient';
        input.message.recipient = input.message.spender;
      },
      input => input.types.PermitDetails.reverse(),
      input => input.types.PermitDetails.pop(),
      input => (input.types.PermitDetails[1].type = 'uint256'),
      input => (input.types.PermitDetails[2].type = 'uint256'),
      input => (input.types.PermitDetails[3].type = 'uint256'),
      input => {
        input.types.PermitDetails.push({name: 'extra', type: 'uint256'});
        const details = batch ? input.message.details : [input.message.details];
        for (const detail of details) detail.extra = '1';
      },
      input => {
        input.types.PermitDetails[0].name = 'asset';
        const details = batch ? input.message.details : [input.message.details];
        for (const detail of details) detail.asset = detail.token;
      },
      input => {
        input.types.Details = input.types.PermitDetails;
        delete input.types.PermitDetails;
        input.types[input.primaryType][0].type = batch
          ? 'Details[]'
          : 'Details';
      },
    ]) {
      const input = permit(batch);
      change(input);
      assert.equal(getEvmPermit2(parseEvmTypedData(input).data), undefined);
    }
  }

  const fixedBatch = permit(true);
  fixedBatch.types.PermitBatch[0].type = 'PermitDetails[1]';
  assert.equal(getEvmPermit2(parseEvmTypedData(fixedBatch).data), undefined);
});

test('the typed-data boundary rejects integers beyond the signed field widths', () => {
  for (const batch of [false, true]) {
    for (const [field, bits] of [
      ['amount', 160n],
      ['expiration', 48n],
      ['nonce', 48n],
      ['sigDeadline', 256n],
    ]) {
      for (const value of ['-1', (2n ** bits).toString()]) {
        const input = permit(batch);
        const detail = batch ? input.message.details[0] : input.message.details;
        if (field === 'sigDeadline') input.message[field] = value;
        else detail[field] = value;

        assert.throws(() => parseEvmTypedData(input));
      }
    }
  }
});

test('leaves signature transfer and witness requests to generic typed-data rendering', () => {
  for (const witness of [false, true]) {
    const input = permit();
    input.primaryType = witness
      ? 'PermitWitnessTransferFrom'
      : 'PermitTransferFrom';
    delete input.types.PermitSingle;
    delete input.types.PermitDetails;
    input.types.TokenPermissions = [
      {name: 'token', type: 'address'},
      {name: 'amount', type: 'uint256'},
    ];
    input.types[input.primaryType] = [
      {name: 'permitted', type: 'TokenPermissions'},
      {name: 'spender', type: 'address'},
      {name: 'nonce', type: 'uint256'},
      {name: 'deadline', type: 'uint256'},
    ];
    input.message = {
      permitted: {
        token: input.message.details.token,
        amount: input.message.details.amount,
      },
      spender: input.message.spender,
      nonce: '7',
      deadline: input.message.sigDeadline,
    };
    if (witness) {
      input.types[input.primaryType].push({name: 'witness', type: 'Order'});
      input.types.Order = [{name: 'recipient', type: 'address'}];
      input.message.witness = {recipient: input.message.spender};
    }

    assert.equal(getEvmPermit2(parseEvmTypedData(input).data), undefined);
  }
});

test('recognition preserves signed data, the original digest and the recovered signer', async () => {
  const wallet = new Wallet(`0x${'1'.padStart(64, '0')}`);

  for (const batch of [false, true]) {
    const input = permit(batch);
    const original = structuredClone(input);
    const {data, digest} = parseEvmTypedData(input);
    const normalized = structuredClone(data);
    const {EIP712Domain, ...types} = input.types;
    const signature = await wallet.signTypedData(
      input.domain,
      types,
      input.message,
    );

    assert.ok(getEvmPermit2(data));
    assert.equal(recoverAddress(digest, signature), wallet.address);
    assert.equal(parseEvmTypedData(data).digest, digest);
    assert.deepEqual(data, normalized);
    assert.deepEqual(input, original);
  }
});

test('typed-data hashing matches the official Permit2 SDK single and batch vectors', () => {
  // Uniswap/sdks: sdks/permit2-sdk/src/allowanceTransfer.test.ts.
  const hashes = [
    '0xd47437bffdbc4d123a2165feb6ca646b8700c038622ce304f84e9048bc744f36',
    '0x49642ada5f77eb9458f8265eb01fed2684c2f25d50534fea3efdf2cf395deb2f',
  ];

  for (const [index, batch] of [false, true].entries()) {
    const input = permit(batch);
    input.domain.verifyingContract = ZeroAddress;
    input.message.spender = ZeroAddress;
    input.message.sigDeadline = '0';
    const detail = batch ? input.message.details[0] : input.message.details;
    Object.assign(detail, {
      token: ZeroAddress,
      amount: '0',
      expiration: '0',
      nonce: '0',
    });

    const {data, digest} = parseEvmTypedData(input);

    assert.equal(digest, hashes[index]);
    assert.equal(getEvmPermit2(data), undefined);
  }
});
