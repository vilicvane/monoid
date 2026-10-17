/* global BigInt */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Interface} from 'ethers';

// eslint-disable-next-line @mufan/scoped-modules -- Test token metadata without platform services.
import {
  formatTokenAmount,
  getErc20AmountIndex,
  getErc20CallTarget,
  getEvmTokenAddressKind,
  parseEvmTokenList,
  readEvmToken,
} from '../.bld/app/@lib/evm-token.js';

// eslint-disable-next-line @mufan/scoped-modules -- Test the shared risk classification.
import {getAddressSeverity} from '../.bld/app/@lib/address-status.js';

const TOKEN = {
  chainId: 1,
  address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  name: 'USD Coin',
  symbol: 'USDC',
  decimals: 6,
  logoURI: 'https://example.test/usdc.png',
};

test('listed token identity removes unknown warnings without overriding ownership or explicit danger', () => {
  const kind = getEvmTokenAddressKind('unknown', true);
  assert.equal(kind, 'listed');
  assert.equal(getEvmTokenAddressKind('seen', true), 'listed');
  assert.equal(getEvmTokenAddressKind('unknown', false), 'unknown');
  assert.equal(getEvmTokenAddressKind('seen', false), 'seen');
  assert.equal(getEvmTokenAddressKind('own', true), 'own');
  assert.equal(getEvmTokenAddressKind('signer', true), 'signer');
  assert.equal(getAddressSeverity(kind, undefined), undefined);
  assert.equal(getAddressSeverity(kind, 'dangerous'), 'danger');
});

test('token identity is chain and address; output is checksummed and drops unrelated metadata', () => {
  const tokens = parseEvmTokenList({
    tokens: [
      {...TOKEN, extensions: {irrelevant: true}},
      {...TOKEN, chainId: 10, decimals: 18},
    ],
  });
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0].address, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  assert.equal(tokens[0].extensions, undefined);
  assert.equal(tokens[1].decimals, 18);
  assert.throws(
    () => parseEvmTokenList({tokens: [TOKEN, tokens[0]]}),
    /Duplicate/,
  );
});

const ERC20 = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]);

test('reads unlisted tokens at the called address without assuming optional metadata', async () => {
  const values = {
    name: 'Unlisted token',
    symbol: 'TOK',
    decimals: 0n,
    totalSupply: 1000n,
    balanceOf: 0n,
    allowance: 0n,
  };
  const provider = {
    async call(request) {
      assert.equal(request.to, TOKEN.address);
      assert.equal(request.enableCcipRead, false);
      const method = ERC20.getFunction(request.data.slice(0, 10));
      if (!(method.name in values)) throw new Error('Unsupported method');
      return ERC20.encodeFunctionResult(method, [values[method.name]]);
    },
  };
  const token = await readEvmToken(provider, 'eip155:1', TOKEN.address);
  assert.equal(token.name, values.name);
  assert.equal(token.decimals, 0);
  assert.equal(token.logoURI, undefined);
  delete values.name;
  delete values.symbol;
  delete values.decimals;
  const anonymous = await readEvmToken(provider, 'eip155:1', TOKEN.address);
  assert.equal(anonymous.name, 'ERC-20');
  assert.equal(anonymous.decimals, undefined);
  // An ERC-721 can expose name, symbol, totalSupply and balanceOf, but not allowance.
  delete values.allowance;
  await assert.rejects(
    readEvmToken(provider, 'eip155:1', TOKEN.address),
    /Unsupported/,
  );
});

test('only links a token to an unambiguous supported call and retains the actual proxy target', () => {
  const call = {
    target: TOKEN.address,
    contractAddress: '0x1111111111111111111111111111111111111111',
    candidates: [{signature: 'transfer(address,uint256)'}],
  };
  assert.equal(getErc20CallTarget(call), TOKEN.address);
  assert.equal(getErc20CallTarget({...call, candidates: []}), undefined);
  assert.equal(
    getErc20CallTarget({
      ...call,
      candidates: [...call.candidates, ...call.candidates],
    }),
    undefined,
  );
  assert.equal(getErc20CallTarget({...call, issue: 'limit'}), undefined);
  assert.equal(
    getErc20CallTarget({
      ...call,
      candidates: [{signature: 'multicall(bytes[])'}],
    }),
    undefined,
  );
});

test('rejects unusable external metadata atomically and ignores unsafe logo URLs', () => {
  for (const change of [
    {chainId: 0},
    {chainId: 1.5},
    {chainId: Number.MAX_SAFE_INTEGER + 1},
    {address: '0x123'},
    {name: ''},
    {symbol: ' '},
    {decimals: -1},
    {decimals: 256},
    {decimals: 1.2},
  ]) {
    assert.throws(() =>
      parseEvmTokenList({tokens: [TOKEN, {...TOKEN, ...change}]}),
    );
  }
  assert.throws(() => parseEvmTokenList({tokens: []}));
  assert.throws(() => parseEvmTokenList(null));
  assert.equal(
    parseEvmTokenList({tokens: [{...TOKEN, logoURI: 'javascript:alert(1)'}]})[0]
      .logoURI,
    undefined,
  );
});

test('formats base units without rounding or floating-point loss', () => {
  assert.equal(formatTokenAmount(123456789n, 6), '123.456789');
  assert.equal(formatTokenAmount(1000000n, 6), '1');
  assert.equal(formatTokenAmount(0n, 18), '0');
  assert.equal(formatTokenAmount(42n, 0), '42');
  assert.equal(formatTokenAmount(1n, 255), `0.${'0'.repeat(254)}1`);
  const maximum = (1n << 256n) - 1n;
  const full = formatTokenAmount(maximum, 18);
  assert.equal(BigInt(full.replace('.', '')), maximum);
});

test('excludes the Solana entries in the Uniswap list from EVM identity', () => {
  const tokens = parseEvmTokenList({
    tokens: [
      TOKEN,
      {
        ...TOKEN,
        chainId: 501000101,
        address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      },
    ],
  });
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].chainId, 1);
});

test('only recognizes exact ERC-20 amount argument layouts', () => {
  assert.equal(getErc20AmountIndex('transfer(address,uint256)'), 1);
  assert.equal(getErc20AmountIndex('approve(address,uint256)'), 1);
  assert.equal(getErc20AmountIndex('transferFrom(address,address,uint256)'), 2);
  assert.equal(
    getErc20AmountIndex('safeTransferFrom(address,address,uint256)'),
    undefined,
  );
  assert.equal(getErc20AmountIndex('approve(address,uint128)'), undefined);
});
