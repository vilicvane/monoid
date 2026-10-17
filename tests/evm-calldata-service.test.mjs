/* global globalThis */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Interface, ZeroAddress, zeroPadValue} from 'ethers';

const {EvmCalldataService} = await import(
  '../.bld/app/@services/evm-calldata-service.js'
);

const TARGET = '0x1111111111111111111111111111111111111111';
const IMPLEMENTATION = '0x2222222222222222222222222222222222222222';
const RECIPIENT = '0x3333333333333333333333333333333333333333';
const TOKEN = new Interface(['function transfer(address to,uint256 amount)']);
const MULTICALL = new Interface(['function multicall(bytes[] data)']);
const DATA = TOKEN.encodeFunctionData('transfer', [RECIPIENT, 42n]);
const SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const EXACT_VERIFICATION = {
  runtimeMatch: 'exact_match',
  creationMatch: 'exact_match',
  verifiedAt: '2026-10-17T00:00:00Z',
};

function contractResponse(
  chainId,
  address,
  iface,
  proxyResolution = {isProxy: false},
  verification,
) {
  return Response.json({
    chainId,
    address,
    abi: JSON.parse(iface.formatJson()),
    proxyResolution,
    ...verification,
  });
}

function signatureResponse(selector, signatures = []) {
  return Response.json({
    ok: true,
    result: {
      function: {
        [selector]: signatures.length ? signatures.map(name => ({name})) : null,
      },
    },
  });
}

function createService(context, implementation = ZeroAddress) {
  const getStorage = context.mock.fn(async () =>
    zeroPadValue(implementation, 32),
  );
  const getRPC = context.mock.fn(async () => ({getStorage}));

  return {service: new EvmCalldataService({getRPC}), getRPC, getStorage};
}

test('contract lookups use the requested chain and never reuse a previous decode ABI', async context => {
  const otherToken = new Interface([
    'function transfer(address beneficiary,uint256 value)',
  ]);
  const fetch = context.mock.method(globalThis, 'fetch', async url => {
    const [, chainId, address] = new URL(url).pathname.match(
      /contract\/(\d+)\/(.+)$/,
    );
    return contractResponse(
      chainId,
      address,
      chainId === '1' ? TOKEN : otherToken,
    );
  });
  const {service, getRPC} = createService(context);

  const ethereum = await service.decode('eip155:1', TARGET, DATA);
  const polygon = await service.decode('eip155:137', TARGET, DATA);
  const again = await service.decode('eip155:1', TARGET, DATA);

  assert.equal(ethereum.candidates[0].fields[0].name, 'to');
  assert.equal(ethereum.contractAddress, TARGET);
  assert.equal(polygon.candidates[0].fields[0].name, 'beneficiary');
  assert.equal(again.candidates[0].source, 'abi');
  assert.equal(fetch.mock.callCount(), 3);
  assert.equal(getRPC.mock.callCount(), 0);
  assert.ok(
    fetch.mock.calls.every(
      ({arguments: [url]}) =>
        new URL(url).searchParams.get('fields') === 'abi,proxyResolution',
    ),
  );
});

test('proxy metadata resolves the implementation ABI on the same network', async context => {
  const implementationVerification = {
    runtimeMatch: 'match',
    creationMatch: null,
    verifiedAt: '2026-10-16T00:00:00Z',
  };
  const fetch = context.mock.method(globalThis, 'fetch', async url => {
    const [, chainId, address] = new URL(url).pathname.match(
      /contract\/(\d+)\/(.+)$/,
    );
    return address === TARGET
      ? contractResponse(
          chainId,
          address,
          new Interface([]),
          {isProxy: true, implementations: [{address: IMPLEMENTATION}]},
          EXACT_VERIFICATION,
        )
      : contractResponse(
          chainId,
          address,
          TOKEN,
          undefined,
          implementationVerification,
        );
  });
  const {service, getRPC} = createService(context);

  const result = await service.decode('eip155:137', TARGET, DATA);

  assert.equal(result.candidates[0].abiAddress, IMPLEMENTATION);
  assert.equal(result.contractAddress, IMPLEMENTATION);
  assert.equal(result.candidates[0].signature, 'transfer(address,uint256)');
  assert.deepEqual(
    result.candidates[0].verification,
    implementationVerification,
  );
  assert.equal(getRPC.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 2);
  assert.ok(
    fetch.mock.calls.every(({arguments: [url]}) => url.includes('/137/')),
  );
});

test('a missing proxy ABI still permits EIP-1967 implementation lookup', async context => {
  context.mock.method(globalThis, 'fetch', async url =>
    url.includes(`/${TARGET}?`)
      ? new Response('', {status: 404})
      : contractResponse('1', IMPLEMENTATION, TOKEN),
  );
  const {service, getRPC, getStorage} = createService(context, IMPLEMENTATION);

  const result = await service.decode('eip155:1', TARGET, DATA);

  assert.equal(result.candidates[0].abiAddress, IMPLEMENTATION);
  assert.deepEqual(getRPC.mock.calls[0].arguments, ['eip155:1']);
  assert.deepEqual(getStorage.mock.calls[0].arguments, [TARGET, SLOT]);
});

test('an unresolved proxy with an admin ABI still discovers its implementation', async context => {
  const admin = new Interface(['function upgradeTo(address implementation)']);
  let resolution;
  context.mock.method(globalThis, 'fetch', async url =>
    url.includes(`/${TARGET}?`)
      ? contractResponse('1', TARGET, admin, resolution, EXACT_VERIFICATION)
      : contractResponse('1', IMPLEMENTATION, TOKEN),
  );
  const {service, getStorage} = createService(context, IMPLEMENTATION);

  for (resolution of [
    {isProxy: true, implementations: []},
    {
      isProxy: true,
      implementations: [],
      proxyResolutionError: {message: 'RPC unavailable'},
    },
    {isProxy: false, proxyResolutionError: {message: 'RPC unavailable'}},
  ]) {
    const result = await service.decode('eip155:1', TARGET, DATA);
    assert.equal(result.candidates[0].abiAddress, IMPLEMENTATION);
    assert.equal(result.candidates[0].verification, undefined);
  }

  const direct = await service.decode(
    'eip155:1',
    TARGET,
    admin.encodeFunctionData('upgradeTo', [IMPLEMENTATION]),
  );
  assert.equal(direct.candidates[0].abiAddress, TARGET);
  assert.equal(direct.contractAddress, IMPLEMENTATION);
  assert.equal(direct.candidates[0].signature, 'upgradeTo(address)');
  assert.deepEqual(direct.candidates[0].verification, EXACT_VERIFICATION);
  assert.equal(getStorage.mock.callCount(), 4);
});

test('proxy RPC failure preserves a directly matching admin ABI', async context => {
  const admin = new Interface(['function upgradeTo(address implementation)']);
  context.mock.method(globalThis, 'fetch', async () =>
    contractResponse(
      '1',
      TARGET,
      admin,
      {isProxy: true, implementations: []},
      EXACT_VERIFICATION,
    ),
  );
  const {service, getRPC} = createService(context);
  getRPC.mock.mockImplementation(async () => {
    throw new Error('RPC unavailable');
  });

  const result = await service.decode(
    'eip155:1',
    TARGET,
    admin.encodeFunctionData('upgradeTo', [IMPLEMENTATION]),
  );

  assert.equal(result.candidates[0].source, 'abi');
  assert.equal(result.candidates[0].abiAddress, TARGET);
  assert.equal(result.contractAddress, undefined);
  assert.equal(result.candidates[0].signature, 'upgradeTo(address)');
  assert.deepEqual(result.candidates[0].verification, EXACT_VERIFICATION);
  assert.equal(getRPC.mock.callCount(), 1);
});

test('successful empty implementation storage confirms an otherwise unknown direct contract', async context => {
  context.mock.method(globalThis, 'fetch', async () =>
    contractResponse('1', TARGET, TOKEN, {}),
  );
  const {service, getStorage} = createService(context);

  const result = await service.decode('eip155:1', TARGET, DATA);

  assert.equal(result.contractAddress, TARGET);
  assert.equal(getStorage.mock.callCount(), 1);
});

test('a known unresolved proxy is not treated as direct when its EIP-1967 slot is empty', async context => {
  context.mock.method(globalThis, 'fetch', async () =>
    contractResponse('1', TARGET, TOKEN, {isProxy: true, implementations: []}),
  );
  const {service, getStorage} = createService(context);

  const result = await service.decode('eip155:1', TARGET, DATA);

  assert.equal(result.candidates[0].abiAddress, TARGET);
  assert.equal(result.contractAddress, undefined);
  assert.equal(getStorage.mock.callCount(), 1);
});

test('preserves exact, ordinary and absent runtime matches without conflating creation verification', async context => {
  let verification;
  context.mock.method(globalThis, 'fetch', async () =>
    contractResponse('1', TARGET, TOKEN, undefined, verification),
  );
  const {service} = createService(context);

  for (verification of [
    EXACT_VERIFICATION,
    {...EXACT_VERIFICATION, runtimeMatch: 'match', creationMatch: 'match'},
    {...EXACT_VERIFICATION, runtimeMatch: null},
    {...EXACT_VERIFICATION, creationMatch: null},
    {...EXACT_VERIFICATION, runtimeMatch: null, creationMatch: null},
  ]) {
    const result = await service.decode('eip155:1', TARGET, DATA);
    assert.deepEqual(result.candidates[0].verification, verification);
  }
});

test('missing or malformed verification metadata does not discard ABI or imply verification', async context => {
  let verification;
  context.mock.method(globalThis, 'fetch', async () =>
    contractResponse('1', TARGET, TOKEN, undefined, verification),
  );
  const {service} = createService(context);

  for (verification of [
    undefined,
    {match: 'exact_match'},
    {runtimeMatch: 'exact_match'},
    {...EXACT_VERIFICATION, runtimeMatch: 'verified'},
    {...EXACT_VERIFICATION, creationMatch: true},
  ]) {
    const result = await service.decode('eip155:1', TARGET, DATA);
    assert.equal(result.candidates[0].source, 'abi');
    assert.equal(result.candidates[0].verification, undefined);
  }

  verification = {...EXACT_VERIFICATION, verifiedAt: 'not a date'};
  const result = await service.decode('eip155:1', TARGET, DATA);
  assert.deepEqual(result.candidates[0].verification, {
    runtimeMatch: 'exact_match',
    creationMatch: 'exact_match',
    verifiedAt: undefined,
  });
});

test('selector candidates do not inherit contract verification or directory verified flags', async context => {
  context.mock.method(globalThis, 'fetch', async url =>
    url.includes('/v2/contract/')
      ? contractResponse('1', TARGET, MULTICALL, undefined, EXACT_VERIFICATION)
      : Response.json({
          ok: true,
          result: {
            function: {
              '0xa9059cbb': [
                {
                  name: 'transfer(address,uint256)',
                  hasVerifiedContract: true,
                },
              ],
            },
          },
        }),
  );
  const {service} = createService(context);
  const result = await service.decode('eip155:1', TARGET, DATA);

  assert.equal(result.candidates[0].source, 'signature');
  assert.equal(result.candidates[0].verification, undefined);
});

test('nested repeated targets and selectors share lookups within one decode', async context => {
  const fetch = context.mock.method(globalThis, 'fetch', async url =>
    url.includes('/v2/contract/')
      ? contractResponse('1', TARGET, MULTICALL)
      : signatureResponse('0xa9059cbb', [
          'transfer(address,uint256)',
          'workMyDirefulOwner(uint256,uint256)',
        ]),
  );
  const {service} = createService(context);
  const result = await service.decode(
    'eip155:1',
    TARGET,
    MULTICALL.encodeFunctionData('multicall', [[DATA, DATA]]),
  );

  const calls = Object.values(result.candidates[0].calls);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].candidates.length, 2);
  assert.equal(calls[1].candidates.length, 2);
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(
    new URL(fetch.mock.calls[1].arguments[0]).searchParams.get('filter'),
    'false',
  );
});

test('wrong-chain metadata and unavailable lookups retain raw data without a false ABI match', async context => {
  const {service} = createService(context);
  context.mock.method(globalThis, 'fetch', async url =>
    url.includes('/v2/contract/')
      ? contractResponse('137', TARGET, TOKEN)
      : new Response('', {status: 503}),
  );

  const result = await service.decode('eip155:1', TARGET, DATA);

  assert.equal(result.data, DATA);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.issue, 'unavailable');
});

test('caller cancellation aborts fetch and rejects with the caller reason', async context => {
  const fetch = context.mock.method(
    globalThis,
    'fetch',
    () => new Promise(() => {}),
  );
  const {service, getRPC} = createService(context);
  const controller = new AbortController();
  const failure = new Error('Review closed');
  const result = service.decode('eip155:1', TARGET, DATA, controller.signal);
  const rejected = assert.rejects(result, error => error === failure);

  controller.abort(failure);
  await rejected;

  assert.equal(fetch.mock.calls[0].arguments[1].signal.aborted, true);
  assert.equal(getRPC.mock.callCount(), 0);
  await assert.rejects(
    service.decode('eip155:1', TARGET, DATA, controller.signal),
    error => error === failure,
  );
  assert.equal(fetch.mock.callCount(), 1);
});

test('stalled HTTP lookup times out while selector fallback can still decode', async context => {
  context.mock.timers.enable({apis: ['setTimeout']});
  const fetch = context.mock.method(globalThis, 'fetch', url =>
    url.includes('/v2/contract/')
      ? new Promise(() => {})
      : Promise.resolve(
          signatureResponse('0xa9059cbb', ['transfer(address,uint256)']),
        ),
  );
  const {service} = createService(context);
  const pending = service.decode('eip155:1', TARGET, DATA);

  context.mock.timers.tick(7999);
  assert.equal(fetch.mock.calls[0].arguments[1].signal.aborted, false);
  context.mock.timers.tick(1);
  const result = await pending;

  assert.equal(fetch.mock.calls[0].arguments[1].signal.aborted, true);
  assert.equal(result.candidates[0].source, 'signature');
  assert.equal(result.issue, 'unavailable');
  assert.equal(result.contractAddress, TARGET);
});

test('stalled shared RPC lookup is bounded without destroying its provider', async context => {
  context.mock.timers.enable({apis: ['setTimeout']});
  context.mock.method(globalThis, 'fetch', async url =>
    url.includes('/v2/contract/')
      ? new Response('', {status: 404})
      : signatureResponse('0xa9059cbb'),
  );
  const started = Promise.withResolvers();
  const provider = {
    getStorage: () => {
      started.resolve();
      return new Promise(() => {});
    },
    destroy: context.mock.fn(),
  };
  const service = new EvmCalldataService({getRPC: async () => provider});
  const pending = service.decode('eip155:1', TARGET, DATA);
  await started.promise;

  context.mock.timers.tick(8000);
  const result = await pending;

  assert.equal(result.issue, 'unavailable');
  assert.deepEqual(result.candidates, []);
  assert.equal(result.contractAddress, undefined);
  assert.equal(provider.destroy.mock.callCount(), 0);
});
