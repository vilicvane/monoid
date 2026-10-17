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

const {createMonoidApplet} = await import(
  '../.bld/app/@lib/monoid/monoid-applet.js'
);
const {getAppletKey} = await import(
  '../.bld/app/@lib/monoid/get-applet-key.js'
);
const {signEvmDigest} = await import(
  '../.bld/app/@lib/monoid/sign-evm-digest.js'
);

const bytes = hex => new Uint8Array(Buffer.from(hex, 'hex'));
const aid = bytes('f06d6f6e6f696401010000');
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

async function createSession(response) {
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

    const result =
      typeof response === 'function' ? response(command) : response;

    return {data: [...encode(result), 0x90, 0]};
  };

  const applet = await createMonoidApplet(aid).openSession('protocol-fixture');

  return {applet, commands};
}

function assertRequest(commands, ins, expected) {
  assert.equal(commands.length, 1);

  const [command] = commands;
  const payload = command.subarray(5);

  assert.deepEqual(
    command.subarray(0, 5),
    new Uint8Array([0, ins, 0, 0, payload.length]),
  );
  assert.deepEqual(payload, encode(expected, {sortKeys: null}));

  const decoded = decode(payload);

  assert.deepEqual(decoded, expected);
  assert.deepEqual(Object.keys(decoded), Object.keys(expected));

  return decoded;
}

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
      {index, type: 'seed', alias: 'Main'},
      {index: bytes('10010000000000000002'), key: keyPrefix, alias: 'Data'},
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

test('Set keeps alias as text and places optional data last', async () => {
  const data = bytes('01020304');
  const {applet, commands} = await createSession({});

  await applet.set({data, alias: '主账户', index});
  assertRequest(commands, 0x33, {index, alias: '主账户', data});

  await assert.rejects(applet.set({index, alias: data}));
  assert.equal(commands.length, 1);
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
