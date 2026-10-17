import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

import {decode, encode} from 'cbor2';
import {
  SigningKey,
  computeAddress,
  getBytes,
  hexlify,
  recoverAddress,
} from 'ethers';

let transceive;

mock.module('capacitor-isodep-nfc', {
  namedExports: {
    IsoDepNfc: {
      transceive: request => transceive(request),
    },
  },
});

const {createMonoidApplet, MonoidAppletHelloWithSafe} = await import(
  '../.bld/app/@lib/monoid/monoid-applet.js'
);
const {CBORAppletError} = await import('../.bld/app/@lib/cbor-applet.js');
const {AppletISOError} = await import('../.bld/app/@lib/applet.js');
const {getAppletKey} = await import(
  '../.bld/app/@lib/monoid/get-applet-key.js'
);
const {signEvmDigest} = await import(
  '../.bld/app/@lib/monoid/sign-evm-digest.js'
);

const bytes = hex => new Uint8Array(Buffer.from(hex, 'hex'));
const aid = bytes('f06d6f6e6f696402010000');
const index = bytes('02400000000000000001');
const indexes = {
  seed: index,
  master: bytes('03200000000000000001'),
  secp256k1: bytes('04010000000000000001'),
  secp256r1: bytes('04020000000000000001'),
  ed25519: bytes('05010000000000000001'),
};
const path = bytes('8000002c8000003c800000000000000000000000');
const digest = new Uint8Array(32).fill(0x12);
const signature = new Uint8Array(64).fill(0x34);
const publicKey = new Uint8Array(33).fill(0x56);
const identityPublicKey = new Uint8Array([4, ...new Uint8Array(64).fill(0x78)]);
const features = {
  curves: [{name: 'secp256r1', ciphers: ['ecdsa']}],
};

async function createSession(response, sw = 0x9000) {
  const commands = [];

  transceive = async request => {
    assert.equal(request.sessionId, 'protocol-fixture');

    const command = Uint8Array.from(request.data);

    if (command[1] === 0xa4) {
      assert.deepEqual(
        command,
        new Uint8Array([0, 0xa4, 4, 0, aid.length, ...aid]),
      );

      return {data: [0x90, 0]};
    }

    commands.push(command);

    if (command[0] === 0x90 || command[0] === 0xb0) {
      return {data: [0x90, 0]};
    }

    if (sw !== 0x9000) {
      return {data: [sw >> 8, sw & 0xff]};
    }

    const result =
      typeof response === 'function' ? response(command) : response;

    return {data: [...encode(result), 0x90, 0]};
  };

  const applet = await createMonoidApplet(aid).openSession('protocol-fixture');

  return {applet, commands};
}

function assertRequest(commands, ins, expected) {
  const encoded = encode(expected, {sortKeys: null});
  const count = Math.ceil(encoded.length / 255);

  assert.equal(commands.length, count);

  for (const [index, command] of commands.entries()) {
    const cla =
      count === 1 ? 0 : index === 0 ? 0x90 : index === count - 1 ? 0xa0 : 0xb0;

    assert.deepEqual(
      command.subarray(0, 5),
      new Uint8Array([
        cla,
        ins,
        0,
        0,
        Math.min(255, encoded.length - index * 255),
      ]),
    );
  }

  const payload = new Uint8Array(
    commands.flatMap(command => [...command.subarray(5)]),
  );

  assert.deepEqual(payload, encoded);

  const decoded = decode(payload);

  assert.deepEqual(decoded, expected);
  assert.deepEqual(Object.keys(decoded), Object.keys(expected));

  return decoded;
}

test('Hello includes Safe identity only when requested and preserves false PIN states', async () => {
  const basic = {version: 1, id: bytes('01020304'), features, pin: false};
  const safe = {
    id: bytes('05060708'),
    publicKey: identityPublicKey,
    pin: false,
    unlocked: false,
  };

  for (const request of [{}, {safe: false}, {safe: true}]) {
    const response = request.safe ? {...basic, safe} : basic;
    const {applet, commands} = await createSession(response);

    assert.deepEqual(await applet.hello(request), response);
    assertRequest(commands, 0x20, request);

    if (request.safe) {
      assert.deepEqual(MonoidAppletHelloWithSafe.satisfies(response), response);
    } else {
      assert.throws(() => MonoidAppletHelloWithSafe.satisfies(response));
    }
  }

  const legacySafe = {id: safe.id, pin: false, unlocked: false};
  const {applet} = await createSession({...basic, safe: legacySafe});

  await assert.rejects(applet.hello({safe: true}));
});

test('System information uses the numeric transient memory values emitted by the card', async () => {
  const response = {
    versions: {monoid: 1, javacard: [3, 0]},
    memories: {
      persistent: {available: 16384},
      transient: {reset: 2048, deselect: 1024},
    },
    features,
  };
  const {applet, commands} = await createSession(response);

  assert.deepEqual(await applet.systemInformation({}), response);
  assertRequest(commands, 0x2f, {});
});

test('raw key requests include their explicit curve type', async () => {
  for (const type of ['secp256k1', 'secp256r1', 'ed25519']) {
    const index = indexes[type];
    const {applet, commands} = await createSession({publicKey});

    assert.deepEqual(await applet.viewKey({type, index}), {publicKey});
    assertRequest(commands, 0x40, {index, type});
  }
});

test('seed and master requests encode each explicit derivation scheme', async () => {
  const context = new TextEncoder().encode('example.com');
  const chainCode = new Uint8Array(32).fill(0x78);

  for (const type of ['seed', 'master']) {
    const index = indexes[type];

    for (const [derivation, expected, response] of [
      [
        {path, type: 'bip32'},
        {type: 'bip32', path},
        {publicKey, chainCode},
      ],
      [
        {path, curve: 'ed25519', type: 'slip10'},
        {type: 'slip10', curve: 'ed25519', path},
        {publicKey: publicKey.subarray(0, 32), chainCode},
      ],
      [
        {context, type: 'monoid-001'},
        {type: 'monoid-001', context},
        {publicKey},
      ],
    ]) {
      const {applet, commands} = await createSession(response);

      assert.deepEqual(
        await applet.viewKey({derivation, type, index}),
        response,
      );

      const decoded = assertRequest(commands, 0x40, {
        index,
        type,
        derivation: expected,
      });

      assert.deepEqual(Object.keys(decoded.derivation), Object.keys(expected));
    }
  }
});

test('Monoid-001 permits an empty binary context', async () => {
  const {applet, commands} = await createSession({publicKey});
  const request = {
    index,
    type: 'seed',
    derivation: {type: 'monoid-001', context: new Uint8Array()},
  };

  await applet.viewKey(request);
  assertRequest(commands, 0x40, request);
});

test('signing preserves each cipher payload and orders metadata before it', async () => {
  const message = new TextEncoder().encode('Monoid fixture 👋');

  for (const [request, expected] of [
    [
      {digest, cipher: 'ecdsa', type: 'secp256k1', index},
      {index, type: 'secp256k1', cipher: 'ecdsa', digest},
    ],
    [
      {digest, cipher: 'ecdsa', type: 'secp256r1', index},
      {index, type: 'secp256r1', cipher: 'ecdsa', digest},
    ],
    [
      {message, cipher: 'ed25519', type: 'ed25519', index},
      {index, type: 'ed25519', cipher: 'ed25519', message},
    ],
    [
      {digest, cipher: 'bip340', type: 'secp256k1', index},
      {index, type: 'secp256k1', cipher: 'bip340', digest},
    ],
  ]) {
    request.index = indexes[request.type];
    expected.index = indexes[expected.type];

    const {applet, commands} = await createSession({signature});

    assert.deepEqual(await applet.sign(request), {signature});
    assertRequest(commands, 0x41, expected);
  }
});

test('derived signatures order nested metadata and Taproot before the digest', async () => {
  const merkleRoot = new Uint8Array(32).fill(0x9a);
  const request = {
    digest,
    taproot: {merkleRoot},
    cipher: 'bip340',
    derivation: {path, type: 'bip32'},
    type: 'seed',
    index,
  };
  const {applet, commands} = await createSession({signature});

  await applet.sign(request);

  const decoded = assertRequest(commands, 0x41, {
    index,
    type: 'seed',
    derivation: {type: 'bip32', path},
    cipher: 'bip340',
    taproot: {merkleRoot},
    digest,
  });

  assert.deepEqual(Object.keys(decoded.derivation), ['type', 'path']);
  assert.deepEqual(Object.keys(decoded.taproot), ['merkleRoot']);
});

test('Taproot boolean and object values survive ViewKey and BIP340 encoding', async () => {
  const index = indexes.secp256k1;

  for (const taproot of [false, true, {}, {merkleRoot: digest}]) {
    for (const method of ['viewKey', 'sign']) {
      const signing = method === 'sign';
      const {applet, commands} = await createSession(
        signing ? {signature} : {publicKey},
      );
      const request = {
        taproot,
        ...(signing && {digest, cipher: 'bip340'}),
        type: 'secp256k1',
        index,
      };

      await applet[method](request);

      assertRequest(commands, signing ? 0x41 : 0x40, {
        index,
        type: 'secp256k1',
        ...(signing && {cipher: 'bip340'}),
        taproot,
        ...(signing && {digest}),
      });
    }
  }
});

test('missing type and old root derivation parameters fail before NFC transmission', async () => {
  const {applet, commands} = await createSession({publicKey, signature});

  for (const key of [
    {index},
    {index, seed: 'Bitcoin seed', curve: 'secp256k1', path},
    {index, type: 'seed', seed: 'Bitcoin seed', curve: 'secp256k1', path},
    {index, type: 'master', curve: 'secp256k1', path},
  ]) {
    await assert.rejects(applet.viewKey(key));
    await assert.rejects(applet.sign({...key, cipher: 'ecdsa', digest}));
  }

  assert.equal(commands.length, 0);
});

test('invalid derivation schemes and cipher combinations fail before NFC transmission', async () => {
  const {applet, commands} = await createSession({publicKey, signature});

  for (const derivation of [
    {type: 'bip32'},
    {type: 'slip10', curve: 'secp256k1', path},
    {type: 'monoid-001', context: 'not bytes'},
  ]) {
    await assert.rejects(applet.viewKey({index, type: 'seed', derivation}));
  }

  await assert.rejects(
    applet.sign({index, type: 'ed25519', cipher: 'ecdsa', digest}),
  );
  await assert.rejects(
    applet.sign({index, type: 'secp256r1', cipher: 'bip340', digest}),
  );
  await assert.rejects(
    applet.sign({index, type: 'secp256k1', cipher: 'ed25519', message: digest}),
  );
  assert.equal(commands.length, 0);
});

test('List encodes its filters and accepts custom items without a type name', async () => {
  const keyPrefix = bytes('010203');
  const response = {
    items: [
      {index, type: 'seed', alias: 'Main', secret: true},
      {
        index: bytes('10010000000000000002'),
        key: keyPrefix,
        alias: 'Data',
        secret: false,
      },
    ],
  };
  const {applet, commands} = await createSession(response);

  assert.deepEqual(await applet.list({keyPrefix, type: 'seed'}), response);
  assertRequest(commands, 0x30, {type: 'seed', keyPrefix});
});

test('empty List request is a one-byte CBOR map', async () => {
  const {applet, commands} = await createSession({items: []});

  assert.deepEqual(await applet.list({}), {items: []});
  assert.deepEqual(commands, [bytes('0030000001a0')]);
});

test('List and View require the secret flag rather than assuming an item is public', async () => {
  const listed = await createSession({items: [{index, type: 'seed'}]});

  await assert.rejects(listed.applet.list({}));

  const viewed = await createSession({alias: 'Main'});

  await assert.rejects(viewed.applet.view({index}));
});

test('Set distinguishes omitted and explicit secret flags after replacement data', async () => {
  const data = bytes('01020304');

  for (const secret of [undefined, false, true]) {
    const options = secret === undefined ? {} : {secret};
    const {applet, commands} = await createSession({});

    await applet.set({...options, data, alias: '主账户', index});
    assertRequest(commands, 0x33, {index, alias: '主账户', data, ...options});
  }

  const {applet, commands} = await createSession({});

  await assert.rejects(applet.set({index, alias: data}));
  assert.equal(commands.length, 0);
});

test('View exposes item metadata and Get returns plaintext bytes', async () => {
  for (const [method, ins, response] of [
    ['view', 0x31, {key: new Uint8Array(), alias: '', secret: true}],
    ['view', 0x31, {secret: false}],
    ['get', 0x32, {data: bytes('000102ff')}],
  ]) {
    const {applet, commands} = await createSession(response);

    assert.deepEqual(await applet[method]({index}), response);
    assertRequest(commands, ins, {index});
  }
});

test('Create supports generated and explicit indexes with data before metadata', async () => {
  const data = bytes('000102ff');
  const key = new TextEncoder().encode('lookup');

  for (const selector of [{type: 'seed'}, {type: 0x1001}, {index}]) {
    const {applet, commands} = await createSession({index});

    assert.deepEqual(
      await applet.create({
        ...selector,
        secret: true,
        alias: '主账户',
        key,
        data,
      }),
      {index},
    );
    assertRequest(commands, 0x34, {
      data,
      key,
      alias: '主账户',
      secret: true,
      ...selector,
    });
  }

  const {applet, commands} = await createSession({index});

  await assert.rejects(applet.create({data}));
  await assert.rejects(applet.create({type: 'seed'}));
  assert.equal(commands.length, 0);
});

test('Remove selects an item by its original index', async () => {
  const {applet, commands} = await createSession({});

  assert.deepEqual(await applet.remove({index}), {});
  assertRequest(commands, 0x35, {index});
});

test('Export and Import preserve opaque data and absent versus empty metadata', async () => {
  // The card owns envelope encryption; this fixture only checks byte preservation.
  const data = Uint8Array.from({length: 144}, (_, index) => index % 256);

  for (const metadata of [{}, {key: new Uint8Array(), alias: ''}]) {
    const response = {...metadata, data};
    const source = await createSession(response);
    const exported = await source.applet.exportItem({
      recipientPublicKey: identityPublicKey,
      index,
    });

    assert.deepEqual(exported, response);
    assertRequest(source.commands, 0x36, {
      index,
      recipientPublicKey: identityPublicKey,
    });

    const target = await createSession({});

    assert.deepEqual(
      await target.applet.importItem({
        ...exported,
        senderPublicKey: identityPublicKey,
        index,
      }),
      {},
    );
    assertRequest(target.commands, 0x37, {
      index,
      senderPublicKey: identityPublicKey,
      ...metadata,
      data,
    });
  }
});

test('Import chains a large encrypted envelope without changing its metadata or bytes', async () => {
  const data = Uint8Array.from({length: 700}, (_, index) => index % 256);
  const key = bytes('00ff');
  const alias = '同步 👋';
  const {applet, commands} = await createSession({});

  assert.deepEqual(
    await applet.importItem({
      data,
      alias,
      key,
      senderPublicKey: identityPublicKey,
      index,
    }),
    {},
  );
  assertRequest(commands, 0x37, {
    index,
    senderPublicKey: identityPublicKey,
    key,
    alias,
    data,
  });
  assert.deepEqual(
    commands.map(command => command[0]),
    [0x90, 0xb0, 0xb0, 0xa0],
  );
});

test('CreateRandomKey covers explicit byte lengths and fixed-length curves', async () => {
  for (const request of [
    ...['entropy', 'seed', 'master'].map(type => ({type, length: 32})),
    ...['secp256k1', 'secp256r1', 'ed25519'].map(type => ({type})),
  ]) {
    const {applet, commands} = await createSession({index});

    assert.deepEqual(await applet.createRandomKey(request), {index});
    assertRequest(commands, 0x38, request);
  }
});

test('Safe access errors retain their card error codes', async () => {
  for (const [method, request, code] of [
    ['get', {index}, 'ACCESS_DENIED'],
    [
      'exportItem',
      {index, recipientPublicKey: identityPublicKey},
      'UNAUTHORIZED',
    ],
  ]) {
    const source = {code};
    const {applet} = await createSession({error: source});

    await assert.rejects(applet[method](request), error => {
      assert.ok(error instanceof CBORAppletError);
      assert.deepEqual(error.source, source);
      assert.equal(error.message, code);

      return true;
    });
  }
});

test('Import preserves ISO status for invalid artifacts and conflicting existing items', async () => {
  for (const sw of [0x6984, 0x6985]) {
    const {applet} = await createSession({}, sw);

    await assert.rejects(
      applet.importItem({
        index,
        senderPublicKey: identityPublicKey,
        data: new Uint8Array(144),
      }),
      error => error instanceof AppletISOError && error.sw === sw,
    );
  }
});

test('Authenticate and SetPIN follow their different firmware field orders', async () => {
  for (const [method, ins, expected, payloadHex] of [
    [
      'authenticate',
      0x21,
      {safe: true, pin: '123456'},
      'a26473616665f56370696e66313233343536',
    ],
    [
      'setPIN',
      0x22,
      {pin: '123456', safe: true},
      'a26370696e663132333435366473616665f5',
    ],
  ]) {
    const {applet, commands} = await createSession({});

    await applet[method](
      Object.fromEntries(Object.entries(expected).reverse()),
    );
    assertRequest(commands, ins, expected);
    assert.deepEqual(commands[0].subarray(5), bytes(payloadHex));
  }
});

test('wallet key selection, wire commands and EVM signature recovery use the same derived account', async () => {
  // Public scalar 1 is a mock card response, not a device or stored credential.
  const signingKey = new SigningKey(`0x${'1'.padStart(64, '0')}`);
  const address = computeAddress(signingKey.publicKey);
  const customPath = "m/44'/60'/7'/1/23";
  const encodedPath = bytes('8000002c8000003c800000070000000100000017');

  for (const type of ['seed', 'master']) {
    const index = indexes[type];
    const reference = getAppletKey(
      {type, index: Buffer.from(index).toString('hex')},
      'evm',
      customPath,
    );
    const {applet, commands} = await createSession(command => {
      const request = decode(command.subarray(5));

      if (command[1] === 0x40) {
        return {publicKey: getBytes(signingKey.compressedPublicKey)};
      }

      assert.equal(command[1], 0x41);

      const {r, s} = signingKey.sign(request.digest);

      return {signature: getBytes(`${r}${s.slice(2)}`)};
    });
    const result = await signEvmDigest(
      applet,
      reference,
      hexlify(digest),
      address,
    );

    assert.equal(recoverAddress(digest, result), address);
    assert.equal(commands.length, 2);
    assertRequest([commands[0]], 0x40, {
      index,
      type,
      derivation: {type: 'bip32', path: encodedPath},
    });
    assertRequest([commands[1]], 0x41, {
      index,
      type,
      derivation: {type: 'bip32', path: encodedPath},
      cipher: 'ecdsa',
      digest,
    });
  }
});
