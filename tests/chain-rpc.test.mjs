import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  ChainstackProvider,
  FetchRequest,
  InfuraProvider,
  toUtf8Bytes,
  toUtf8String,
} from 'ethers';

import {ChainService} from '../.bld/app/@services/chain-service.js';

function mockRPC(context, Provider, respond) {
  const calls = [];
  const factory = context.mock.method(Provider, 'getRequest', () => {
    const request = new FetchRequest('https://rpc.example');
    request.getUrlFunc = async outgoing => {
      const payload = JSON.parse(toUtf8String(outgoing.body));
      calls.push(payload);
      return {
        statusCode: 200,
        statusMessage: 'OK',
        headers: {},
        body: toUtf8Bytes(
          JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            result: await respond(payload),
          }),
        ),
      };
    };
    return request;
  });
  return {factory, calls};
}

test('checks the remote chain and shares a successful provider across callers', async context => {
  const primary = mockRPC(context, ChainstackProvider, () => '0x1');
  const fallback = mockRPC(context, InfuraProvider, () => '0x1');
  const service = new ChainService({});
  const pending = service.getRPC('eip155:1');

  assert.equal(service.getRPC('eip155:1'), pending);
  const provider = await pending;
  context.after(() => provider.destroy());
  assert.equal(await service.getRPC('eip155:1'), provider);
  assert.equal(primary.factory.mock.callCount(), 1);
  assert.deepEqual(
    primary.calls.map(call => call.method),
    ['eth_chainId'],
  );
  assert.equal(fallback.factory.mock.callCount(), 0);
});

test('tries the next provider when the first is unreachable or returns a different chain', async context => {
  for (const respond of [
    () => {
      throw new Error('Offline');
    },
    () => '0x89',
  ]) {
    const primary = mockRPC(context, ChainstackProvider, respond);
    const fallback = mockRPC(context, InfuraProvider, () => '0x1');
    const service = new ChainService({});
    const provider = await service.getRPC('eip155:1');
    provider.destroy();

    assert.equal(primary.calls.length, 1);
    assert.deepEqual(
      fallback.calls.map(call => call.method),
      ['eth_chainId'],
    );
    primary.factory.mock.restore();
    fallback.factory.mock.restore();
  }
});

test('a failed connection can be retried instead of retaining a rejected promise', async context => {
  let online = false;
  const primary = mockRPC(context, ChainstackProvider, () => {
    if (!online) throw new Error('Offline');
    return '0x1';
  });
  mockRPC(context, InfuraProvider, () => {
    throw new Error('Offline');
  });
  const service = new ChainService({});

  await assert.rejects(service.getRPC('eip155:1'), /Offline/);
  online = true;
  const provider = await service.getRPC('eip155:1');
  provider.destroy();
  assert.equal(primary.factory.mock.callCount(), 2);
});

test('rejects invalid network IDs and networks absent from the community providers', async () => {
  const service = new ChainService({});
  for (const chainId of ['solana:mainnet', 'eip155:0', 'eip155:01']) {
    await assert.rejects(service.getRPC(chainId), /does not support EVM/);
  }
  await assert.rejects(service.getRPC('eip155:999999999'));
});
