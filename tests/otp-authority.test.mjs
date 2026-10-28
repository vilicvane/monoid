import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {p256} from '@noble/curves/nist';
import {base64urlnopad} from '@scure/base';

import {
  OTPAuthorityWarmup,
  resolveOTPAuthorityInstallationOptions,
} from '../.bld/app/@lib/otp-authority.js';

const key = p256.getPublicKey(1n, false);
const signal = () => new AbortController().signal;

test('Authority warm-up is nonblocking, consumes the public response and deduplicates normalized URLs', async t => {
  const requests = [];
  const consumed = t.mock.fn(async () => new ArrayBuffer(0));
  let complete;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    requests.push({url, options});
    return new Promise(resolve => {
      complete = () => resolve({arrayBuffer: consumed});
    });
  });
  const warmup = new OTPAuthorityWarmup(signal());
  assert.equal(warmup.start('https://authority.example'), undefined);
  warmup.start('https://authority.example/');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://authority.example/v1/metadata');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.equal(requests[0].options.body, undefined);
  assert.equal(consumed.mock.callCount(), 0);
  complete();
  await setImmediate();
  assert.equal(consumed.mock.callCount(), 1);
  warmup.stop();
});

test('warm-up is optional and cancelled on owner abort or completion', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    requests.push(options);
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        'abort',
        () => reject(options.signal.reason),
        {once: true},
      );
    });
  });
  for (const end of ['abort', 'stop']) {
    const owner = new AbortController();
    const warmup = new OTPAuthorityWarmup(owner.signal);
    warmup.start(false);
    warmup.start(undefined);
    warmup.start('');
    const count = requests.length;
    warmup.start('https://authority.example');
    assert.equal(requests.length, count + 1);
    if (end === 'abort') owner.abort();
    else warmup.stop();
    assert.equal(requests.at(-1).signal.aborted, true);
    warmup.start('https://other.example');
    assert.equal(requests.length, count + 1);
    await setImmediate();
  }
});

test('a failed or invalid hint does not block warming the actual card service', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(url);
    throw new Error('Offline');
  });
  const warmup = new OTPAuthorityWarmup(signal());
  warmup.start('invalid hint');
  warmup.start('https://old.example');
  warmup.start('https://actual.example');
  // A local worker keeps its base path; the API lives beneath it.
  warmup.start('http://localhost:8787/api/authority');
  await setImmediate();
  assert.deepEqual(requests, [
    'https://old.example/v1/metadata',
    'https://actual.example/v1/metadata',
    'http://localhost:8787/api/authority/v1/metadata',
  ]);
  warmup.stop();
});

test('installation resolves the selected Authority and normalizes its URL', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://100.64.0.1:8787/v1/metadata');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({publicKey: base64urlnopad.encode(key)});
  });
  assert.deepEqual(
    await resolveOTPAuthorityInstallationOptions(
      ' http://100.64.0.1:8787/ ',
      signal(),
    ),
    {
      authorityUrl: 'http://100.64.0.1:8787/',
      authorityPublicKey: key,
    },
  );
});

test('disabling Authority requires no service request', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('unexpected request'),
  );
  assert.deepEqual(
    await resolveOTPAuthorityInstallationOptions('', signal()),
    {},
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test('invalid URLs are rejected before fetching or starting card work', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('unexpected request'),
  );
  for (const url of [
    'not a URL',
    'file:///authority',
    'https://user:password@example.com',
    'https://example.com?key=1',
    'https://example.com/#key',
    `https://example.com/${'a'.repeat(150)}`,
  ]) {
    await assert.rejects(
      resolveOTPAuthorityInstallationOptions(url, signal()),
      /[Aa]uthority URL/,
    );
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('invalid metadata or public keys stop initialization', async t => {
  for (const metadata of [
    null,
    {},
    {publicKey: 'bad!'},
    {publicKey: base64urlnopad.encode(p256.getPublicKey(1n, true))},
    {publicKey: base64urlnopad.encode(new Uint8Array(65))},
  ]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () =>
      Response.json(metadata),
    );
    await assert.rejects(
      resolveOTPAuthorityInstallationOptions('https://example.com', signal()),
      /Invalid authority public key/,
    );
    fetch.mock.restore();
  }
});

test('service failures do not silently initialize a card without Authority', async t => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, {status: 503}),
  );
  await assert.rejects(
    resolveOTPAuthorityInstallationOptions('https://example.com', signal()),
    /Could not connect to the authority/,
  );
});

test('cancellation after receiving metadata prevents installation', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => {
    controller.abort();
    return Response.json({publicKey: base64urlnopad.encode(key)});
  });
  await assert.rejects(
    resolveOTPAuthorityInstallationOptions(
      'https://example.com',
      controller.signal,
    ),
    {name: 'AbortError'},
  );
});
