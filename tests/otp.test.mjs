import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

import {p256} from '@noble/curves/nist';
import {base32nopad, base64urlnopad} from '@scure/base';
import {decode, encode} from 'cbor2';
import {getBytes, sha256, toUtf8Bytes} from 'ethers';

let exchange;
mock.module('capacitor-isodep-nfc', {
  namedExports: {
    IsoDepNfc: {
      async transceive(options) {
        return {data: await exchange(options)};
      },
    },
  },
});

const {
  OTP_AID,
  OTP_ITEM_TYPE,
  calculatePreparedOTP,
  currentOTPCode,
  otpCodeState,
  decodeOTPBatch,
  decodeOTPConfiguration,
  decodeOTPKeyReference,
  decodeOTPSecret,
  decodeOTPTimeProof,
  encodeOTPConfiguration,
  fetchOTPTimeProof,
  parseOTPURI,
  prepareOTP,
} = await import('../.bld/app/@lib/otp.js');
const {createMonoidApplet} = await import(
  '../.bld/app/@lib/monoid/monoid-applet.js'
);
const {createOTPApplet} = await import('../.bld/app/@lib/otp-applet.js');

const bytes = value => Uint8Array.from(Buffer.from(value, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const index = bytes('f2010102030405060708');
const index2 = bytes('f2011112131415161718');
const privateKey = 9n;
const publicKey = p256.getPublicKey(privateKey, false);
const authority = {endpoint: 'https://authority.example', publicKey};
const signal = () => new AbortController().signal;
const uint64 = value => {
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, value);
  return output;
};

function timeResponse(challenge, time = 59n, key = privateKey) {
  const data = new Uint8Array([1, ...uint64(time), ...challenge]);
  const message = new Uint8Array([
    ...toUtf8Bytes('Monoid Authority Time'),
    ...data,
  ]);
  const signature = p256
    .sign(getBytes(sha256(message)), key)
    .toCompactRawBytes();
  return {
    publicKey: base64urlnopad.encode(p256.getPublicKey(key, false)),
    data: base64urlnopad.encode(data),
    signature: base64urlnopad.encode(signature),
  };
}

test('OTP import decodes RFC 4648 secrets and standard TOTP URI defaults', () => {
  const secret = toUtf8Bytes('12345678901234567890');
  const encoded = base32nopad.encode(secret);
  const account = parseOTPURI(
    `otpauth://totp/alice%40example.test?secret=${encoded}&issuer=Example`,
  );
  assert.deepEqual(account, {
    label: 'Example: alice@example.test',
    secret,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
  assert.deepEqual(decodeOTPSecret(' my====== '), toUtf8Bytes('f'));
  assert.deepEqual(decodeOTPSecret('my'), toUtf8Bytes('f'));
  assert.equal(
    parseOTPURI(
      `otpauth://totp/Example%3Aalice?secret=${encoded}&issuer=Example&algorithm=sha512&digits=8&period=60`,
    ).algorithm,
    'SHA512',
  );
});

test('OTP import accepts issuer display differences and nonzero unused secret bits', () => {
  const account = parseOTPURI(
    'otpauth://totp/Example%20Login%3Aalice?secret=MZXW6YTBOJ&issuer=Example',
  );
  assert.equal(account.label, 'Example Login:alice');
  assert.deepEqual(account.secret, toUtf8Bytes('foobar'));
  assert.equal(account.algorithm, 'SHA1');
  assert.equal(account.digits, 6);
  assert.equal(account.period, 30);

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  for (const text of ['f', 'fo', 'foo', 'foob', 'foobar']) {
    const secret = toUtf8Bytes(text);
    const canonical = base32nopad.encode(secret);
    const unusedBits = (canonical.length * 5) % 8;
    const last = alphabet.indexOf(canonical.at(-1));
    for (let trailing = 0; trailing < 1 << unusedBits; trailing++) {
      const value = canonical.slice(0, -1) + alphabet[last | trailing];
      assert.deepEqual(decodeOTPSecret(value.toLowerCase()), secret);
      assert.deepEqual(
        decodeOTPSecret(value.padEnd(Math.ceil(value.length / 8) * 8, '=')),
        secret,
      );
    }
  }
});

test('OTP import rejects unsupported semantics without silently replacing options', () => {
  const valid = 'otpauth://totp/Example%3Aalice?secret=MY';
  for (const uri of [
    valid.replace('totp', 'hotp'),
    `${valid}&counter=5`,
    `${valid}&algorithm=MD5`,
    `${valid}&algorithm=SHA1&algorithm=SHA256`,
    'otpauth://totp/alice?secret=MY&issuer=Example%0AInjected',
    `${valid}&digits=7`,
    `${valid}&period=0`,
    `${valid}&period=32768`,
    `${valid}&period=1.5`,
    `${valid}#secret`,
    'otpauth://totp/Example%3A?secret=MY',
    'otpauth://totp/%GG?secret=MY',
    'otpauth://totp/alice?secret=',
  ])
    assert.throws(() => parseOTPURI(uri), undefined, uri);

  for (const secret of [
    'M',
    'MZX',
    'MZXW6Y',
    'MY=',
    'MY======A',
    '1O',
    '',
    'MY!',
  ])
    assert.throws(() => decodeOTPSecret(secret), undefined, secret);
  assert.equal(
    decodeOTPSecret(base32nopad.encode(new Uint8Array(255))).length,
    255,
  );
  assert.throws(() => decodeOTPSecret(base32nopad.encode(new Uint8Array(256))));
});

test('OTP metadata matches firmware F201 configuration and exact HMAC references', () => {
  assert.equal(OTP_ITEM_TYPE, 0xf201);
  assert.equal(hex(OTP_AID), 'f06d6f6e6f69640501');
  for (const [algorithm, id] of [
    ['SHA1', 1],
    ['SHA256', 2],
    ['SHA512', 3],
  ]) {
    const configuration = {algorithm, digits: 8, period: 32767};
    const encoded = encodeOTPConfiguration(configuration);
    assert.deepEqual(encoded, new Uint8Array([1, id, 8, 0x7f, 0xff]));
    assert.deepEqual(decodeOTPConfiguration(encoded), configuration);
  }
  for (const key of [
    [1, 1, 6, 0, 0],
    [1, 1, 6, 0x80, 0],
    [1, 0, 6, 0, 30],
    [1, 4, 6, 0, 30],
    [1, 1, 7, 0, 30],
    [2, 1, 6, 0, 30],
    [1, 1, 6, 30],
  ])
    assert.throws(() => decodeOTPConfiguration(new Uint8Array(key)));

  assert.equal(
    decodeOTPKeyReference(bytes('05140102030405060708')),
    '05140102030405060708',
  );
  for (const key of [
    '05000102030405060708',
    '02400102030405060708',
    '05140102',
  ])
    assert.throws(() => decodeOTPKeyReference(bytes(key)));
});

test('signed time checks challenge, pinned key, domain signature and unsigned 64-bit time', () => {
  const challenge = new Uint8Array(32).fill(77);
  const time = (1n << 63n) + 123n;
  const response = timeResponse(challenge, time);
  assert.equal(decodeOTPTimeProof(response, challenge, publicKey).time, time);
  assert.equal(decodeOTPTimeProof(response, challenge).time, time);
  assert.throws(() =>
    decodeOTPTimeProof(response, new Uint8Array(32), publicKey),
  );
  assert.throws(() =>
    decodeOTPTimeProof(response, challenge, p256.getPublicKey(10n, false)),
  );
  const signature = base64urlnopad.decode(response.signature);
  signature[0] ^= 1;
  assert.throws(() =>
    decodeOTPTimeProof(
      {...response, signature: base64urlnopad.encode(signature)},
      challenge,
      publicKey,
    ),
  );
  assert.throws(() =>
    decodeOTPTimeProof(
      {...response, data: `${response.data}=`},
      challenge,
      publicKey,
    ),
  );
  const changedData = base64urlnopad.decode(response.data);
  changedData[1] ^= 1;
  assert.throws(() =>
    decodeOTPTimeProof(
      {...response, data: base64urlnopad.encode(changedData)},
      challenge,
      publicKey,
    ),
  );
});

test('time fetch posts only a fresh challenge and preserves aborts and failures', async t => {
  const challenge = new Uint8Array(32).fill(33);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({url, options});
    return Response.json(timeResponse(challenge));
  });
  const proof = await fetchOTPTimeProof(challenge, authority, signal());
  assert.equal(proof.time, 59n);
  assert.ok(proof.receivedAt >= proof.requestedAt);
  assert.equal(
    requests[0].url,
    'https://authority.example/api/authority/v1/time',
  );
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    challenge: base64urlnopad.encode(challenge),
  });
  assert.equal(requests[0].options.cache, 'no-store');
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(fetchOTPTimeProof(challenge, authority, aborted.signal));
  assert.equal(requests.length, 1);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', {status: 429}),
  );
  await assert.rejects(
    fetchOTPTimeProof(challenge, authority, signal()),
    /verified time/,
  );
});

test('batch results remain bound to selected account order and prepared signed time', () => {
  const anchor = {time: 59n, requestedAt: 10, receivedAt: 20};
  const response = {
    time: uint64(59n),
    items: [
      {index, period: 30, codes: ['001234', '005678', '009012']},
      {index: index2, period: 60, codes: ['12345678', '23456789', '34567890']},
    ],
  };
  const batch = decodeOTPBatch(response, [index, index2], anchor);
  assert.equal(batch.items[0].codes[0], '001234');
  assert.equal(batch.items[1].period, 60);
  assert.throws(() => decodeOTPBatch(response, [index2, index], anchor));
  assert.throws(() =>
    decodeOTPBatch({...response, time: uint64(60n)}, [index, index2], anchor),
  );
  for (const item of [
    {...response.items[0], period: 0},
    {...response.items[0], codes: ['123456', '123456']},
    {...response.items[0], codes: ['123456', '123456', '12345678']},
    {...response.items[0], codes: ['123456', '123456', '12x456']},
  ])
    assert.throws(() =>
      decodeOTPBatch({time: uint64(59n), items: [item]}, [index], anchor),
    );
});

test('code windows use continuous monotonic time and expire after the final preloaded window', () => {
  const item = {
    index: hex(index),
    period: 30,
    codes: ['111111', '222222', '333333'],
  };
  for (const anchor of [
    {time: 60n, requestedAt: 1000, receivedAt: 1100},
    {time: 60n, requestedAt: 1000, receivedAt: 1100, secondStartedAt: 500},
  ]) {
    const origin = anchor.secondStartedAt ?? 550;
    for (let now = 1100; now < origin + 90000; now += 50) {
      const state = otpCodeState(anchor, item, now);
      const offset = Math.floor((now - origin) / 30000);
      assert.equal(state.current.code, item.codes[offset]);
      assert.equal(state.prefetched, 2 - offset);
      assert.equal(state.exhausted, false);
      assert.ok(state.progress > 0 && state.progress <= 1);
    }
    assert.equal(currentOTPCode(anchor, item, origin + 29999).code, '111111');
    assert.equal(currentOTPCode(anchor, item, origin + 30000).code, '222222');
    assert.equal(currentOTPCode(anchor, item, origin + 59999).code, '222222');
    assert.equal(currentOTPCode(anchor, item, origin + 60000).code, '333333');
    assert.equal(currentOTPCode(anchor, item, origin + 90000), undefined);
    assert.deepEqual(otpCodeState(anchor, item, origin + 90000), {
      progress: 0,
      prefetched: 0,
      exhausted: true,
    });
    assert.equal(currentOTPCode(anchor, item, 100), undefined);
  }
  assert.equal(
    currentOTPCode(
      {time: (1n << 63n) + 2n, requestedAt: 1000, receivedAt: 1100},
      item,
      1100,
    ).code,
    '111111',
  );
});

test('countdown decreases within a window and resets immediately with the next code', () => {
  const anchor = {
    time: 60n,
    requestedAt: 1000,
    receivedAt: 1100,
    secondStartedAt: 500,
  };
  const item = {
    index: hex(index),
    period: 30,
    codes: ['111111', '222222', '333333'],
  };
  assert.ok(
    otpCodeState(anchor, item, 2000).progress <
      otpCodeState(anchor, item, 1900).progress,
  );
  const before = otpCodeState(anchor, item, 30499),
    after = otpCodeState(anchor, item, 30500);
  assert.equal(before.current.remaining, 1);
  assert.equal(after.current.remaining, 30);
  assert.equal(after.progress, 1);
  assert.equal(after.prefetched, 1);
});

test('selected OTP calculation uses one NFC session and explicit post-prepare Monoid authorization', async t => {
  const challenge = new Uint8Array(32).fill(44);
  const commands = [];
  const stages = [];
  let selected;
  exchange = ({sessionId, data}) => {
    assert.equal(sessionId, 'otp-single-tap');
    if (data[1] === 0xa4) {
      selected = hex(new Uint8Array(data.slice(5)));
      commands.push(['select', selected]);
      return [0x90, 0];
    }
    const request = decode(new Uint8Array(data.slice(5)));
    commands.push([selected, data[1], request]);
    if (selected === hex(OTP_AID) && [0x21, 0x22].includes(data[1]))
      assert.equal(stages.at(-1), data[1] === 0x21 ? 'preparing' : 'verifying');
    const response =
      data[1] === 0x21 && selected === hex(OTP_AID)
        ? {challenge}
        : data[1] === 0x23
          ? {
              time: uint64(59n),
              items: [
                {index, period: 30, codes: ['123456', '234567', '345678']},
              ],
            }
          : {};
    return [...encode(response), 0x90, 0];
  };
  t.mock.method(globalThis, 'fetch', async () => {
    assert.equal(stages.at(-1), 'time');
    return Response.json(timeResponse(challenge));
  });
  const monoid = await createMonoidApplet().openSession('otp-single-tap');
  const prepared = await prepareOTP(
    monoid,
    [index],
    authority.endpoint,
    signal(),
    stage => stages.push(stage),
  );
  assert.deepEqual(stages, ['preparing', 'time', 'verifying']);
  const authenticated = await monoid.useSession(prepared.applet);
  await authenticated.authenticate({pin: '123456', aid: OTP_AID});
  const result = await calculatePreparedOTP(prepared, authenticated, signal());
  assert.equal(result.items[0].codes[0], '123456');
  const business = commands.filter(command => command[0] !== 'select');
  assert.deepEqual(
    business.map(command => command[1]),
    [0x21, 0x22, 0x21, 0x23],
  );
  assert.deepEqual(business[1][2].indices, [index]);
  assert.deepEqual(Object.keys(business[1][2]), [
    'data',
    'signature',
    'indices',
  ]);
  assert.deepEqual(business[2][2], {pin: '123456', aid: OTP_AID});
  assert.deepEqual(business[3][2], {});
  assert.equal(commands.filter(command => command[0] === 'select').length, 4);

  const count = commands.length;
  for (const indices of [
    [],
    [index, index],
    [bytes('f1010102030405060708')],
    Array(17).fill(index),
  ])
    await assert.rejects(
      prepareOTP(monoid, indices, authority.endpoint, signal()),
    );
  assert.equal(
    commands.length,
    count,
    'invalid selection must fail before touching NFC',
  );
});

test('OTP command framing keeps time proof before selection and reads the fixed batch size', async () => {
  exchange = ({data}) => {
    if (data[1] === 0xa4) return [0x90, 0];
    assert.equal(data[1], 0x20);
    return [
      ...encode({version: new Uint8Array([0, 0]), batchSize: 3}),
      0x90,
      0,
    ];
  };
  const applet = await createOTPApplet().openSession('otp-hello');
  assert.equal((await applet.hello({})).batchSize, 3);
});

test('a card without Authority prepares phone time without a challenge or network in one NFC session', async t => {
  t.mock.method(Date, 'now', () => 62_900);
  t.mock.method(globalThis, 'fetch', () =>
    assert.fail('Unsigned time must stay offline'),
  );
  const commands = [];
  let selected;
  exchange = ({sessionId, data}) => {
    assert.equal(sessionId, 'otp-offline');
    if (data[1] === 0xa4) {
      selected = hex(new Uint8Array(data.slice(5)));
      return [0x90, 0];
    }
    const request = decode(new Uint8Array(data.slice(5)));
    commands.push({selected, ins: data[1], request});
    const response =
      data[1] === 0x23
        ? {
            time: uint64(62n),
            items: [{index, period: 30, codes: ['001234', '005678', '009012']}],
          }
        : {};
    return [...encode(response), 0x90, 0];
  };
  const monoid = await createMonoidApplet().openSession('otp-offline');
  const stages = [];
  const prepared = await prepareOTP(monoid, [index], false, signal(), stage =>
    stages.push(stage),
  );
  assert.deepEqual(stages, ['preparing']);
  assert.deepEqual(commands, [
    {
      selected: hex(OTP_AID),
      ins: 0x22,
      request: {time: uint64(62n), indices: [index]},
    },
  ]);
  assert.deepEqual(Object.keys(commands[0].request), ['time', 'indices']);
  const authenticated = await monoid.useSession(prepared.applet);
  await authenticated.authenticate({pin: '123456', aid: OTP_AID});
  const batch = await calculatePreparedOTP(prepared, authenticated, signal());
  assert.deepEqual(
    commands.map(c => c.ins),
    [0x22, 0x21, 0x23],
  );
  assert.equal(batch.time, 62n);
  assert.equal(
    currentOTPCode(batch, batch.items[0], prepared.time.receivedAt)?.code,
    '001234',
  );
  assert.equal(
    currentOTPCode(batch, batch.items[0], prepared.time.receivedAt + 30_000)
      ?.code,
    '005678',
  );
  assert.equal(
    currentOTPCode(batch, batch.items[0], prepared.time.receivedAt + 90_000),
    undefined,
  );
});

test('Authority failures and card proof rejection never retry with phone time', async t => {
  const challenge = new Uint8Array(32).fill(55);
  let failure;
  const commands = [];
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'https://card-authority.example/api/authority/v1/time');
    if (failure === 'network') throw new Error('Offline');
    if (failure === 'http') return new Response('', {status: 503});
    const response = timeResponse(challenge, 62n, 10n);
    if (failure === 'signature')
      response.signature = base64urlnopad.encode(new Uint8Array(64));
    return Response.json(response);
  });
  exchange = ({data}) => {
    if (data[1] === 0xa4) return [0x90, 0];
    const request = decode(new Uint8Array(data.slice(5)));
    commands.push({ins: data[1], request});
    if (data[1] === 0x21) return [...encode({challenge}), 0x90, 0];
    assert.equal(data[1], 0x22);
    assert.deepEqual(Object.keys(request), ['data', 'signature', 'indices']);
    // The response can be well signed by a key different from the installed one.
    // Identity's Prepare rejection remains authoritative; no local-time retry.
    return [0x69, 0x82];
  };
  for (failure of ['network', 'http', 'signature', 'card-key']) {
    commands.length = 0;
    const monoid = await createMonoidApplet().openSession(
      'otp-authority-failure',
    );
    await assert.rejects(
      prepareOTP(monoid, [index], 'https://card-authority.example', signal()),
    );
    assert.deepEqual(
      commands.map(c => c.ins),
      failure === 'card-key' ? [0x21, 0x22] : [0x21],
    );
    assert(commands.every(c => !('time' in c.request)));
  }
});
