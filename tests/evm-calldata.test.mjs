import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Interface, ZeroAddress, getAddress} from 'ethers';

const {decodeEvmCalldata, getEvmCalldataAddresses, getEvmCalldataCalls} =
  await import('../.bld/app/@lib/evm-calldata.js');

const ROUTER = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const IMPLEMENTATION = '0x3333333333333333333333333333333333333333';
const RECIPIENT = getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');

function createResolver(contracts = {}, signatures = {}) {
  const requests = {contracts: [], signatures: []};

  return {
    requests,
    async getContract(address) {
      requests.contracts.push(address);
      const contract = contracts[address.toLowerCase()];
      return contract instanceof Interface
        ? {iface: contract, implementations: [], isProxy: false}
        : (contract ?? {implementations: []});
    },
    async getSignatures(selector) {
      requests.signatures.push(selector);
      return signatures[selector] ?? [];
    },
  };
}

const value = (name, type, value) => ({name, type, kind: 'value', value});

test('decodes ABI tuples and arrays without losing exact integers, booleans or empty values', async () => {
  const iface = new Interface([
    'function submit((address recipient,uint256 amount,bool enabled,string note,bytes data)[] entries,uint256[2] bounds,int256 delta,bool[] flags,bytes payload,string memo)',
  ]);
  const maximum = 2n ** 256n - 1n;
  const delta = -(2n ** 200n);
  const data = iface.encodeFunctionData('submit', [
    [[RECIPIENT, maximum, false, '', '0x']],
    [0n, maximum],
    delta,
    [],
    '0x',
    '',
  ]);
  const resolver = createResolver({[TOKEN]: iface});
  const result = await decodeEvmCalldata(data, TOKEN, resolver);

  assert.equal(result.data, data);
  assert.equal(result.target, TOKEN);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].source, 'abi');
  assert.equal(result.candidates[0].abiAddress, TOKEN);
  assert.deepEqual(result.candidates[0].fields, [
    {
      name: 'entries',
      type: 'tuple(address,uint256,bool,string,bytes)[]',
      kind: 'array',
      children: [
        {
          name: '[0]',
          type: 'tuple(address,uint256,bool,string,bytes)',
          kind: 'struct',
          children: [
            value('recipient', 'address', RECIPIENT),
            value('amount', 'uint256', maximum.toString()),
            value('enabled', 'bool', false),
            value('note', 'string', ''),
            value('data', 'bytes', '0x'),
          ],
        },
      ],
    },
    {
      name: 'bounds',
      type: 'uint256[2]',
      kind: 'array',
      children: [
        value('[0]', 'uint256', '0'),
        value('[1]', 'uint256', maximum.toString()),
      ],
    },
    value('delta', 'int256', delta.toString()),
    {name: 'flags', type: 'bool[]', kind: 'array', children: []},
    value('payload', 'bytes', '0x'),
    value('memo', 'string', ''),
  ]);
  assert.deepEqual(resolver.requests.signatures, []);
});

test('recursively decodes multicall using the same target ABI instance', async () => {
  const iface = new Interface([
    'function multicall(bytes[] data)',
    'function transfer(address recipient,uint256 amount)',
  ]);
  const transfer = iface.encodeFunctionData('transfer', [RECIPIENT, 7n]);
  const inner = iface.encodeFunctionData('multicall', [[transfer]]);
  const outer = iface.encodeFunctionData('multicall', [[inner, transfer]]);
  const resolver = createResolver({[ROUTER]: iface});
  const result = await decodeEvmCalldata(outer, ROUTER, resolver);
  const nested = result.candidates[0].calls['0.0'];
  const leaf = nested.candidates[0].calls['0.0'];

  assert.equal(nested.candidates[0].signature, 'multicall(bytes[])');
  assert.equal(leaf.candidates[0].signature, 'transfer(address,uint256)');
  assert.equal(leaf.candidates[0].fields[1].value, '7');
  assert.equal(result.candidates[0].calls['0.1'].data, transfer);
  assert.deepEqual(resolver.requests.contracts, [
    ROUTER,
    ROUTER,
    ROUTER,
    ROUTER,
  ]);
  assert.deepEqual(resolver.requests.signatures, []);
  assert.deepEqual(getEvmCalldataAddresses(result), [RECIPIENT.toLowerCase()]);
});

test('routes aggregate3 calls to their targets and recursively decodes execute payloads', async () => {
  const router = new Interface([
    'function aggregate3((address target,bool allowFailure,bytes callData)[] calls)',
    'function execute(address target,uint256 value,bytes data)',
  ]);
  const token = new Interface([
    'function transfer(address recipient,uint256 amount)',
  ]);
  const transfer = token.encodeFunctionData('transfer', [RECIPIENT, 19n]);
  const execute = router.encodeFunctionData('execute', [TOKEN, 0n, transfer]);
  const data = router.encodeFunctionData('aggregate3', [
    [
      [TOKEN, false, transfer],
      [ROUTER, true, execute],
    ],
  ]);
  const resolver = createResolver({[ROUTER]: router, [TOKEN]: token});
  const result = await decodeEvmCalldata(data, ROUTER, resolver);
  const direct = result.candidates[0].calls['0.0.2'];
  const indirect = result.candidates[0].calls['0.1.2'];

  assert.equal(direct.target, TOKEN);
  assert.equal(direct.candidates[0].signature, 'transfer(address,uint256)');
  assert.equal(indirect.target, ROUTER);
  assert.equal(
    indirect.candidates[0].signature,
    'execute(address,uint256,bytes)',
  );
  assert.equal(indirect.candidates[0].calls['2'].target, TOKEN);
  assert.equal(indirect.candidates[0].calls['2'].data, transfer);
  assert.deepEqual(resolver.requests.contracts, [ROUTER, TOKEN, ROUTER, TOKEN]);
});

test('does not interpret arbitrary bytes parameters as embedded calls', async () => {
  const iface = new Interface([
    'function submit(bytes signature,bytes[] proofs)',
    'function transfer(address recipient,uint256 amount)',
  ]);
  const transfer = iface.encodeFunctionData('transfer', [RECIPIENT, 1n]);
  const data = iface.encodeFunctionData('submit', [transfer, [transfer]]);
  const resolver = createResolver({[TOKEN]: iface});
  const result = await decodeEvmCalldata(data, TOKEN, resolver);

  assert.equal(result.candidates[0].fields[0].value, transfer);
  assert.equal(result.candidates[0].fields[1].children[0].value, transfer);
  assert.deepEqual(result.candidates[0].calls, {});
  assert.deepEqual(resolver.requests.contracts, [TOKEN]);
});

test('retains all canonical selector collisions instead of selecting the first signature', async () => {
  const data = `0x42966c68${'0'.repeat(64)}`;
  const resolver = createResolver(
    {},
    {
      '0x42966c68': ['burn(uint256)', 'collate_propagate_storage(bytes16)'],
    },
  );
  const result = await decodeEvmCalldata(data, TOKEN, resolver);

  assert.deepEqual(
    result.candidates.map(candidate => candidate.signature),
    ['burn(uint256)', 'collate_propagate_storage(bytes16)'],
  );
  assert.ok(
    result.candidates.every(candidate => candidate.source === 'signature'),
  );
  assert.equal(result.candidates[0].fields[0].value, '0');
  assert.equal(result.candidates[1].fields[0].value, `0x${'0'.repeat(32)}`);
  assert.equal(result.data, data);
});

test('preserves malformed, noncanonical and trailing calldata as raw data', async () => {
  const iface = new Interface(['function enable(bool enabled)']);
  const canonical = iface.encodeFunctionData('enable', [true]);
  const selector = canonical.slice(0, 10);
  const resolver = createResolver(
    {[TOKEN]: iface},
    {[selector]: ['enable(bool)']},
  );

  for (const data of [
    '0x',
    `${selector}00`,
    `${selector}${'0'.repeat(63)}2`,
    `${canonical}00`,
    `${canonical}${'0'.repeat(64)}`,
    `${selector}${'g'.repeat(64)}`,
  ]) {
    const result = await decodeEvmCalldata(data, TOKEN, resolver);
    assert.deepEqual(result.candidates, [], data);
    assert.equal(result.data, data);
  }
});

test('uses implementation ABI when the proxy has no direct ABI', async () => {
  const iface = new Interface([
    'function transfer(address recipient,uint256 amount)',
  ]);
  const data = iface.encodeFunctionData('transfer', [RECIPIENT, 31n]);
  const resolver = createResolver({
    [TOKEN]: {implementations: [IMPLEMENTATION]},
    [IMPLEMENTATION]: iface,
  });
  const result = await decodeEvmCalldata(data, TOKEN, resolver);

  assert.equal(result.target, TOKEN);
  assert.equal(result.candidates[0].abiAddress, IMPLEMENTATION);
  assert.equal(result.candidates[0].source, 'abi');
  assert.deepEqual(resolver.requests.contracts, [TOKEN, IMPLEMENTATION]);
  assert.deepEqual(resolver.requests.signatures, []);
});

test('nested calls keep only their ABI owners verification, including proxy implementations', async () => {
  const router = new Interface([
    'function aggregate((address target,bytes callData)[] calls)',
  ]);
  const token = new Interface([
    'function transfer(address recipient,uint256 amount)',
  ]);
  const routerVerification = {
    runtimeMatch: 'exact_match',
    creationMatch: 'exact_match',
  };
  const proxyVerification = {runtimeMatch: 'match', creationMatch: null};
  const transfer = token.encodeFunctionData('transfer', [RECIPIENT, 1n]);
  const contracts = {
    [ROUTER]: {
      iface: router,
      implementations: [],
      verification: routerVerification,
    },
    [TOKEN]: {
      implementations: [IMPLEMENTATION],
      verification: proxyVerification,
    },
    [IMPLEMENTATION]: {iface: token, implementations: []},
  };
  const data = router.encodeFunctionData('aggregate', [[[TOKEN, transfer]]]);

  const unverified = await decodeEvmCalldata(
    data,
    ROUTER,
    createResolver(contracts),
  );
  assert.deepEqual(unverified.candidates[0].verification, routerVerification);
  const nested = unverified.candidates[0].calls['0.0.1'].candidates[0];
  assert.equal(nested.abiAddress, IMPLEMENTATION);
  assert.equal(nested.verification, undefined);

  const implementationVerification = {
    runtimeMatch: 'exact_match',
    creationMatch: null,
  };
  contracts[IMPLEMENTATION].verification = implementationVerification;
  const verified = await decodeEvmCalldata(
    data,
    ROUTER,
    createResolver(contracts),
  );
  assert.deepEqual(
    verified.candidates[0].calls['0.0.1'].candidates[0].verification,
    implementationVerification,
  );
});

test('final implementation identity is shared across proxies and changes on upgrade', async () => {
  const iface = new Interface([
    'function transfer(address recipient,uint256 amount)',
  ]);
  const data = iface.encodeFunctionData('transfer', [RECIPIENT, 1n]);
  const contracts = {
    [ROUTER]: {implementations: [IMPLEMENTATION], isProxy: true},
    [TOKEN]: {implementations: [IMPLEMENTATION], isProxy: true},
    [IMPLEMENTATION]: iface,
    [RECIPIENT.toLowerCase()]: iface,
  };

  const first = await decodeEvmCalldata(
    data,
    ROUTER,
    createResolver(contracts),
  );
  const second = await decodeEvmCalldata(
    data,
    TOKEN,
    createResolver(contracts),
  );
  assert.equal(first.contractAddress, IMPLEMENTATION);
  assert.equal(second.contractAddress, IMPLEMENTATION);
  assert.deepEqual(getEvmCalldataCalls(first), getEvmCalldataCalls(second));
  assert.deepEqual(getEvmCalldataCalls(first), [
    {
      contractAddress: IMPLEMENTATION,
      signature: 'transfer(address,uint256)',
    },
  ]);

  contracts[TOKEN].implementations = [RECIPIENT];
  const upgraded = await decodeEvmCalldata(
    data,
    TOKEN,
    createResolver(contracts),
  );
  assert.equal(upgraded.contractAddress, RECIPIENT);
  assert.notDeepEqual(
    getEvmCalldataCalls(upgraded),
    getEvmCalldataCalls(first),
  );
});

test('resolves the full implementation chain even when the proxy ABI matches first', async () => {
  const iface = new Interface([
    'function transfer(address recipient,uint256 amount)',
  ]);
  const data = iface.encodeFunctionData('transfer', [RECIPIENT, 1n]);
  const resolver = createResolver({
    [ROUTER]: {iface, implementations: [TOKEN], isProxy: true},
    [TOKEN]: {implementations: [IMPLEMENTATION], isProxy: true},
    [IMPLEMENTATION]: new Interface([]),
  });

  const result = await decodeEvmCalldata(data, ROUTER, resolver);

  assert.equal(result.candidates[0].abiAddress, ROUTER);
  assert.equal(result.contractAddress, IMPLEMENTATION);
  assert.deepEqual(resolver.requests.contracts, [
    ROUTER,
    TOKEN,
    IMPLEMENTATION,
  ]);
});

test('selector fallback retains resolved contract identity without borrowing ABI ownership', async () => {
  const iface = new Interface([
    'function transfer(address recipient,uint256 amount)',
  ]);
  const data = iface.encodeFunctionData('transfer', [RECIPIENT, 1n]);
  const result = await decodeEvmCalldata(
    data,
    ROUTER,
    createResolver(
      {
        [ROUTER]: {implementations: [IMPLEMENTATION], isProxy: true},
        [IMPLEMENTATION]: new Interface([]),
      },
      {'0xa9059cbb': ['transfer(address,uint256)']},
    ),
  );

  assert.equal(result.contractAddress, IMPLEMENTATION);
  assert.equal(result.candidates[0].source, 'signature');
  assert.equal(result.candidates[0].abiAddress, undefined);
  assert.deepEqual(getEvmCalldataCalls(result), [
    {
      contractAddress: IMPLEMENTATION,
      signature: 'transfer(address,uint256)',
    },
  ]);
});

test('unknown, unresolved, multiple and cyclic implementations never use the outer proxy identity', async () => {
  const iface = new Interface([
    'function transfer(address recipient,uint256 amount)',
  ]);
  const data = iface.encodeFunctionData('transfer', [RECIPIENT, 1n]);

  for (const contract of [
    {iface, implementations: []},
    {iface, implementations: [], isProxy: true},
    {iface, implementations: [TOKEN, IMPLEMENTATION], isProxy: true},
    {iface, implementations: [ROUTER], isProxy: true},
    {iface, implementations: [TOKEN], isProxy: true},
  ]) {
    const result = await decodeEvmCalldata(
      data,
      ROUTER,
      createResolver({
        [ROUTER]: contract,
        [TOKEN]: {implementations: [ROUTER], isProxy: true},
        [IMPLEMENTATION]: iface,
      }),
    );
    assert.equal(result.candidates[0].abiAddress, ROUTER);
    assert.equal(result.contractAddress, undefined);
    assert.deepEqual(getEvmCalldataCalls(result), []);
  }
});

test('implementation lookup failure preserves a matching ABI without inventing a contract identity', async () => {
  const iface = new Interface([
    'function transfer(address recipient,uint256 amount)',
  ]);
  const data = iface.encodeFunctionData('transfer', [RECIPIENT, 1n]);
  const result = await decodeEvmCalldata(data, ROUTER, {
    async getContract(address) {
      if (address === ROUTER)
        return {iface, implementations: [IMPLEMENTATION], isProxy: true};
      throw new Error('Offline');
    },
    async getSignatures() {
      return [];
    },
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.contractAddress, undefined);
  assert.deepEqual(getEvmCalldataCalls(result), []);
});

test('implementation depth limit leaves identity unresolved instead of using an intermediate proxy', async () => {
  const iface = new Interface([
    'function transfer(address recipient,uint256 amount)',
  ]);
  const data = iface.encodeFunctionData('transfer', [RECIPIENT, 1n]);
  const addresses = Array.from(
    {length: 10},
    (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`,
  );
  const contracts = Object.fromEntries(
    addresses.map((address, index) => [
      address,
      index === addresses.length - 1
        ? iface
        : {iface, implementations: [addresses[index + 1]], isProxy: true},
    ]),
  );
  const resolver = createResolver(contracts);
  const result = await decodeEvmCalldata(data, addresses[0], resolver);

  assert.equal(result.candidates.length, 1);
  assert.equal(result.contractAddress, undefined);
  assert.equal(result.issue, 'limit');
  assert.equal(resolver.requests.contracts.length, 8);
  assert.deepEqual(getEvmCalldataCalls(result), []);
});

test('call history deduplicates methods but keeps different canonical signatures separate', async () => {
  const iface = new Interface([
    'function multicall(bytes[] data)',
    'function approve(address spender,uint256 amount)',
    'function transfer(address recipient,uint256 amount)',
  ]);
  const approve = iface.encodeFunctionData('approve', [RECIPIENT, 1n]);
  const transfer = iface.encodeFunctionData('transfer', [RECIPIENT, 1n]);
  const result = await decodeEvmCalldata(
    iface.encodeFunctionData('multicall', [[approve, transfer, approve]]),
    TOKEN,
    createResolver({[TOKEN]: iface}),
  );

  assert.deepEqual(getEvmCalldataCalls(result), [
    {contractAddress: TOKEN, signature: 'multicall(bytes[])'},
    {contractAddress: TOKEN, signature: 'approve(address,uint256)'},
    {contractAddress: TOKEN, signature: 'transfer(address,uint256)'},
  ]);

  result.candidates.push({
    ...result.candidates[0],
    signature: 'another(bytes[])',
  });
  assert.deepEqual(getEvmCalldataCalls(result), []);
});

test('retains a raw unknown nested call beside a decoded sibling', async () => {
  const iface = new Interface([
    'function multicall(bytes[] data)',
    'function transfer(address recipient,uint256 amount)',
  ]);
  const transfer = iface.encodeFunctionData('transfer', [RECIPIENT, 1n]);
  const data = iface.encodeFunctionData('multicall', [
    ['0x12345678', transfer],
  ]);
  const result = await decodeEvmCalldata(
    data,
    TOKEN,
    createResolver({[TOKEN]: iface}),
  );

  assert.equal(result.candidates[0].calls['0.0'].data, '0x12345678');
  assert.deepEqual(result.candidates[0].calls['0.0'].candidates, []);
  assert.equal(
    result.candidates[0].calls['0.1'].candidates[0].signature,
    'transfer(address,uint256)',
  );
  assert.deepEqual(getEvmCalldataAddresses(result, true), [
    RECIPIENT.toLowerCase(),
  ]);
  assert.deepEqual(getEvmCalldataCalls(result), [
    {contractAddress: TOKEN, signature: 'multicall(bytes[])'},
    {contractAddress: TOKEN, signature: 'transfer(address,uint256)'},
  ]);
});

test('bounds recursion depth without discarding the remaining payload', async () => {
  const iface = new Interface([
    'function multicall(bytes[] data)',
    'function transfer(address recipient,uint256 amount)',
  ]);
  let data = iface.encodeFunctionData('transfer', [RECIPIENT, 1n]);
  for (let index = 0; index < 8; index++) {
    data = iface.encodeFunctionData('multicall', [[data]]);
  }
  const resolver = createResolver({[TOKEN]: iface});
  let result = await decodeEvmCalldata(data, TOKEN, resolver);

  for (let depth = 0; depth < 7; depth++) {
    assert.equal(result.candidates[0].signature, 'multicall(bytes[])');
    result = result.candidates[0].calls['0.0'];
  }
  assert.equal(result.issue, 'limit');
  assert.deepEqual(result.candidates, []);
  assert.ok(result.data.startsWith(iface.getFunction('multicall').selector));
  assert.equal(resolver.requests.contracts.length, 7);
});

test('bounds decoded call count while keeping every unparsed sibling accessible', async () => {
  const iface = new Interface([
    'function multicall(bytes[] data)',
    'function transfer(address recipient,uint256 amount)',
  ]);
  const transfer = iface.encodeFunctionData('transfer', [RECIPIENT, 1n]);
  const data = iface.encodeFunctionData('multicall', [
    Array(70).fill(transfer),
  ]);
  const resolver = createResolver({[TOKEN]: iface});
  const result = await decodeEvmCalldata(data, TOKEN, resolver);
  const calls = Object.values(result.candidates[0].calls);

  assert.equal(calls.length, 70);
  assert.equal(calls.filter(call => call.candidates.length === 1).length, 63);
  assert.equal(calls.filter(call => call.issue === 'limit').length, 7);
  assert.ok(calls.every(call => call.data === transfer));
  assert.equal(resolver.requests.contracts.length, 64);
});

test('collects ambiguous addresses for review but excludes them from signed history', async () => {
  const router = new Interface(['function multicall(bytes[] data)']);
  const token = new Interface([
    'function approve(address spender,uint256 amount)',
    'function transfer(address recipient,uint256 amount)',
  ]);
  const approve = token.encodeFunctionData('approve', [ZeroAddress, 1n]);
  const transfer = token.encodeFunctionData('transfer', [RECIPIENT, 2n]);
  const resolver = createResolver(
    {[ROUTER]: router},
    {
      '0x095ea7b3': [
        'approve(address,uint256)',
        'sign_szabo_bytecode(bytes16,uint128)',
      ],
      '0xa9059cbb': ['transfer(address,uint256)'],
    },
  );
  const result = await decodeEvmCalldata(
    router.encodeFunctionData('multicall', [[approve, transfer]]),
    ROUTER,
    resolver,
  );

  assert.equal(result.candidates[0].calls['0.0'].candidates.length, 2);
  assert.deepEqual(getEvmCalldataAddresses(result), [
    ZeroAddress,
    RECIPIENT.toLowerCase(),
  ]);
  assert.deepEqual(getEvmCalldataAddresses(result, true), [
    RECIPIENT.toLowerCase(),
  ]);
  assert.deepEqual(getEvmCalldataCalls(result), [
    {contractAddress: ROUTER, signature: 'multicall(bytes[])'},
    {contractAddress: ROUTER, signature: 'transfer(address,uint256)'},
  ]);
});
