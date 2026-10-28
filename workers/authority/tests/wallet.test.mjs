import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {getAddress, hashMessage, serializeErc6492Signature} from 'viem';
import {createSiweMessage} from 'viem/siwe';
import {
  formatMessage,
  createEncodedRecap,
} from '../web/node_modules/@walletconnect/utils/dist/index.js';
import {setup, signer} from './login-fixture.mjs';

async function nonce(f, flow, address = signer.address) {
  const response = await f.call(
    '/auth/login/wallet/nonce',
    {flow: flow.flow, address, chainId: 'eip155:1'},
    undefined,
    flow.headers,
  );
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
const verify = (f, flow, message, signature) =>
  f.call(
    '/auth/login/wallet/verify',
    {flow: flow.flow, message, signature},
    undefined,
    flow.headers,
  );

test('WalletConnect pre-connection nonce binds the signed address and all server metadata', async t => {
  const f = setup(t),
    flow = await f.begin(),
    challenge = await nonce(f, flow, '');
  assert.equal(challenge.message, undefined);
  const data = challenge.data;
  // Use the installed SDK's formatter, including recap text and lowercase DID
  // address, rather than assuming WalletConnect formats messages like viem.
  const connector = readFileSync(
    new URL(
      '../web/node_modules/@reown/appkit-controllers/dist/esm/src/controllers/AdapterController/WalletConnectConnector.js',
      import.meta.url,
    ),
    'utf8',
  );
  const methods = [
    ...connector
      .slice(connector.indexOf('const OPTIONAL_METHODS'))
      .matchAll(/'([^']+)'/g),
  ].map(match => match[1]);
  assert.ok(methods.includes('personal_sign'));
  const message = formatMessage(
    {
      domain: data.domain,
      aud: data.uri,
      version: data.version,
      nonce: data.nonce,
      iat: data.issuedAt,
      exp: data.expirationTime,
      statement: data.statement,
      resources: [createEncodedRecap('eip155', 'request', methods)],
    },
    'did:pkh:eip155:1:' + signer.address.toLowerCase(),
  );
  const signature = await signer.signMessage({message});
  assert.equal((await verify(f, flow, message, signature)).status, 200);
  const session = await (
    await f.call('/auth/login/token', await f.complete(flow))
  ).json();
  assert.equal(session.account.id, 'eip155:' + signer.address.toLowerCase());
});

for (const field of [
  'domain',
  'nonce',
  'expirationTime',
  'issuedAt',
  'statement',
  'uri',
])
  test(`WalletConnect generic challenge rejects altered ${field}`, async t => {
    const f = setup(t),
      flow = await f.begin(),
      challenge = await nonce(f, flow, '');
    const data = {
      ...challenge.data,
      address: signer.address,
      chainId: 1,
      issuedAt: new Date(challenge.data.issuedAt),
      expirationTime: new Date(challenge.data.expirationTime),
    };
    const changes = {
      domain: 'evil.test',
      nonce: 'aaaaaaaa',
      expirationTime: new Date(Date.now() + 3600000),
      issuedAt: new Date(0),
      statement: 'Different purpose',
      uri: 'https://evil.test',
    };
    const message = createSiweMessage({...data, [field]: changes[field]});
    assert.equal(
      (await verify(f, flow, message, await signer.signMessage({message})))
        .status,
      400,
    );
  });

test('EOA SIWE signs the Authority domain/URI, verifies locally and produces one wallet owner', async t => {
  const f = setup(t),
    flow = await f.begin(),
    challenge = await nonce(f, flow);
  assert.equal(challenge.data.domain, 'authority.monoid.app');
  assert.equal(challenge.data.uri, f.env.AUTHORITY_URL);
  const signature = await signer.signMessage({message: challenge.message});
  const response = await verify(f, flow, challenge.message, signature);
  assert.equal(response.status, 200);
  const account = {
    source: 'wallet',
    id: 'eip155:' + signer.address.toLowerCase(),
    displayName: getAddress(signer.address),
  };
  assert.deepEqual(await response.json(), {account});
  assert.equal(f.upstream.rpcCalls.length, 0);
  const session = await (
    await f.call('/auth/login/token', await f.complete(flow))
  ).json();
  assert.deepEqual(session.account, account);
  assert.deepEqual(
    (
      await (
        await f.call('/v1/namespaces', undefined, session.accessToken)
      ).json()
    ).namespaces,
    [account],
  );
});

for (const kind of ['domain', 'uri', 'nonce', 'expiry', 'address'])
  test(`SIWE rejects changed ${kind}`, async t => {
    const f = setup(t),
      flow = await f.begin(),
      challenge = await nonce(f, flow);
    let message = challenge.message;
    if (kind === 'domain')
      message = message.replace(
        'authority.monoid.app wants',
        'evil.test wants',
      );
    if (kind === 'uri')
      message = message.replace(
        'URI: ' + f.env.AUTHORITY_URL,
        'URI: https://evil.test',
      );
    if (kind === 'nonce')
      message = message.replace(challenge.data.nonce, 'a'.repeat(32));
    if (kind === 'expiry')
      message = message.replace(
        challenge.data.expirationTime,
        '2000-01-01T00:00:00.000Z',
      );
    if (kind === 'address')
      message = message.replace(signer.address, '0x' + '22'.repeat(20));
    const signature = await signer.signMessage({message});
    assert.equal((await verify(f, flow, message, signature)).status, 400);
    assert.equal(
      (
        await f.call(
          '/auth/login/complete',
          {flow: flow.flow},
          undefined,
          flow.headers,
        )
      ).status,
      400,
    );
  });

test('wallet nonce expires, cannot cross browsers or flows, and only mainnet is supported', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = setup(t),
    flow = await f.begin(),
    challenge = await nonce(f, flow),
    other = await f.begin();
  const signature = await signer.signMessage({message: challenge.message});
  assert.equal(
    (await verify(f, other, challenge.message, signature)).status,
    400,
  );
  now += 5 * 60000;
  assert.equal(
    (await verify(f, flow, challenge.message, signature)).status,
    400,
  );
  assert.equal(
    (
      await f.call(
        '/auth/login/wallet/nonce',
        {flow: flow.flow, address: signer.address, chainId: 'eip155:10'},
        undefined,
        flow.headers,
      )
    ).status,
    400,
  );
});

for (const kind of ['ERC-1271', 'ERC-6492'])
  test(`${kind} signature is checked through the configured RPC universal verifier`, async t => {
    const f = setup(t),
      flow = await f.begin(),
      address = '0x' + '22'.repeat(20),
      challenge = await nonce(f, flow, address);
    const signature =
      kind === 'ERC-1271'
        ? '0x1234'
        : serializeErc6492Signature({
            address: '0x' + '33'.repeat(20),
            data: '0x1234',
            signature: '0x5678',
          });
    assert.equal(
      (await verify(f, flow, challenge.message, signature)).status,
      200,
    );
    assert.equal(f.upstream.rpcCalls[0].method, 'eth_chainId');
    const call = f.upstream.rpcCalls.find(call => call.method === 'eth_call');
    assert.ok(call);
    // The deployless validator executes ERC-1271 or the ERC-6492 factory wrapper.
    assert.ok(call.params[0].data.includes(address.slice(2)));
    assert.ok(
      call.params[0].data.includes(hashMessage(challenge.message).slice(2)),
    );
    assert.ok(call.params[0].data.includes(signature.slice(2)));
    assert.equal(
      (await verify(f, flow, challenge.message, signature)).status,
      400,
    );
  });

test('RPC rejection, failure, or a different chain never authenticates a contract wallet', async t => {
  const f = setup(t);
  for (const changes of [
    {rpcValid: false},
    {rpcValid: true, chainId: '0xa'},
    {chainId: '0x1', rpcError: true},
  ]) {
    Object.assign(f.upstream, changes);
    const flow = await f.begin(),
      challenge = await nonce(f, flow, '0x' + '22'.repeat(20));
    assert.ok(
      [400, 502].includes(
        (await verify(f, flow, challenge.message, '0x1234')).status,
      ),
    );
    assert.equal(
      (
        await f.call(
          '/auth/login/complete',
          {flow: flow.flow},
          undefined,
          flow.headers,
        )
      ).status,
      400,
    );
  }
});

test('an in-flight contract verification cannot restore a reset or cancelled flow', async t => {
  for (const action of ['reset', 'cancel']) {
    const f = setup(t),
      flow = await f.begin(),
      challenge = await nonce(f, flow, '0x' + '22'.repeat(20));
    let release, started;
    const waiting = new Promise(resolve => {
      started = resolve;
    });
    f.upstream.beforeRpc = () => {
      started();
      return new Promise(resolve => {
        release = resolve;
      });
    };
    const pending = verify(f, flow, challenge.message, '0x1234');
    await waiting;
    await f.call(
      '/auth/login/' + action,
      {flow: flow.flow},
      undefined,
      flow.headers,
    );
    f.upstream.beforeRpc = undefined;
    release();
    assert.equal((await pending).status, 400);
  }
});
