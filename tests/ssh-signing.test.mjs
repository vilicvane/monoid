import assert from 'node:assert/strict';
import {
  createECDH,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign,
  verify,
} from 'node:crypto';
import {test} from 'node:test';

import {
  createSSHAccount,
  decodeBase64,
  encodeBase64,
  parseSSHAccount,
  sha256,
  verifySSHSignature,
} from '@monoid/ssh-protocol';
import {ed25519} from '@noble/curves/ed25519';
import {p256} from '@noble/curves/nist';
import {decode} from 'cbor2';

import {monoidCommandDefinitions} from '../.bld/app/@lib/monoid/monoid-applet.js';
import {signSSHData} from '../.bld/app/@lib/monoid/sign-ssh-data.js';
import {reviewSSHData} from '../.bld/app/@lib/ssh-request.js';
import {
  buildWalletConnectNamespaces,
  requestsSSHAccounts,
} from '../.bld/app/@lib/wallet-connect.js';
import {xCBOR} from '../.bld/app/@x-value/index.js';

const secret = new Uint8Array(32).fill(7);
const bytes = new TextEncoder().encode('unchanged SSH bytes');
const paramsFor = (account, data = bytes) => ({
  account,
  algorithm: parseSSHAccount(account).algorithm,
  data: encodeBase64(data),
  expiresAt: Math.floor(Date.now() / 1000) + 90,
});
const string = value => {
  const data =
    typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, data.length);
  return Buffer.concat([header, data]);
};

// Public fixtures from monoid-javacard/doc/monoid-001.md and
// Monoid001Ed25519Test.java, checked with Node crypto rather than the App signer.
const monoidSeed = Uint8Array.from({length: 64}, (_, index) => index);
const monoidLabel = Buffer.from('Monoid-001');
const fromHex = value => Buffer.from(value, 'hex');
const edVectors = [
  {
    context: '',
    message: '',
    privateKeySeed:
      '3ca45f0809035fdfc7820573d8c3d0829939945aef1361517f0f44f4ecdeabc8',
    publicKey:
      '3bac0815174a5af3eed1636eef4ff0b7f3fa225f952c40a64d84012449fb8273',
    signature:
      '3e5a4292f07a942c439c39b4f746ee7b76019f1c7ae6e74bc53206356dcf2bae8' +
      'cd9ad8af93f98174c8acab8aeb6f94797ec2adf7b8fb590fad03288e8391806',
  },
  {
    context: '00010200ff',
    message: '72',
    privateKeySeed:
      '83e8916442da94f6b66e13836b0f065c60825eaf87955d876044e01fe1be9b39',
    publicKey:
      '62e52cd8effc619db4a8daa340b5aa8f56d506e38710d2d5ee7b1ed1cf43ce89',
    signature:
      'f859527363fe3ef4250f62a89dc60759aac1835e41a710b7b0ef7067c22d3ca5b9' +
      '692ac9c91bc55f239624d460a53016fedcff2553a2261115ed4858b88ad40e',
  },
];

test('Monoid-001 Ed25519 firmware vectors match independent HKDF, public keys and pure signatures', () => {
  for (const vector of edVectors) {
    const info = Buffer.concat([
      monoidLabel,
      fromHex('01'),
      fromHex(vector.context),
      fromHex('00'),
    ]);
    const secret = Buffer.from(
      hkdfSync('sha512', monoidSeed, monoidLabel, info, 32),
    );
    assert.equal(secret.toString('hex'), vector.privateKeySeed);
    const privateKey = createPrivateKey({
      key: Buffer.concat([fromHex('302e020100300506032b657004220420'), secret]),
      format: 'der',
      type: 'pkcs8',
    });
    const publicKey = createPublicKey(privateKey);
    assert.equal(
      publicKey
        .export({format: 'der', type: 'spki'})
        .subarray(-32)
        .toString('hex'),
      vector.publicKey,
    );
    const signature = sign(null, fromHex(vector.message), privateKey);
    assert.equal(signature.toString('hex'), vector.signature);
    assert.equal(
      verify(null, fromHex(vector.message), publicKey, signature),
      true,
    );

    // The low-level Applet API also preserves opaque binary contexts.
    const request = {
      type: 'seed',
      index: Uint8Array.from(fromHex('02400000000000000001')),
      derivation: {
        type: 'monoid-001',
        curve: 'ed25519',
        context: Uint8Array.from(fromHex(vector.context)),
      },
      cipher: 'ed25519',
      message: Uint8Array.from(fromHex(vector.message)),
    };
    assert.deepEqual(
      decode(monoidCommandDefinitions.sign.request.encode(xCBOR, request)),
      request,
    );
  }
});

test('Monoid-001 P-256 empty-context vector retains its existing curve-separated key', () => {
  const info = Buffer.concat([monoidLabel, fromHex('0000')]);
  const secret = Buffer.from(
    hkdfSync('sha512', monoidSeed, monoidLabel, info, 32),
  );
  assert.equal(
    secret.toString('hex'),
    '9858d02b1d88118d84a69262fdf7526417803c9b44c66455493840f658be9f9c',
  );
  assert.notEqual(secret.toString('hex'), edVectors[0].privateKeySeed);
  const key = createECDH('prime256v1');
  key.setPrivateKey(secret);
  assert.equal(
    key.getPublicKey('hex', 'compressed'),
    '025ba8761994ac159a921f4ea3d46ef333849eda9441c540b9997cc438a018d458',
  );
});

test('SSH signing binds the empty-context Ed25519 firmware public key and verifies its signature', async () => {
  const vector = edVectors[0];
  const account = createSSHAccount('ed25519', fromHex(vector.publicKey));
  const source = {
    type: 'seed',
    index: '02400000000000000001',
    derivation: {type: 'monoid-001', curve: 'ed25519', context: ''},
    account,
  };
  let reference;
  const result = await signSSHData(
    {
      async viewKey(request) {
        reference = decode(
          monoidCommandDefinitions.viewKey.request.encode(xCBOR, request),
        );
        assert.equal(reference.derivation.curve, 'ed25519');
        assert.deepEqual(reference.derivation.context, new Uint8Array());
        return {publicKey: fromHex(vector.publicKey)};
      },
      async sign(request) {
        const actual = decode(
          monoidCommandDefinitions.sign.request.encode(xCBOR, request),
        );
        assert.deepEqual(actual, {
          ...reference,
          cipher: 'ed25519',
          message: new Uint8Array(),
        });
        return {signature: fromHex(vector.signature)};
      },
    },
    source,
    paramsFor(account, new Uint8Array()),
    () => {},
  );
  assert.equal(
    verifySSHSignature(account, new Uint8Array(), decodeBase64(result)),
    true,
  );
});

for (const type of ['ed25519', 'p256']) {
  test(`${type}: binds the actual key and signs original bytes with the required hash semantics`, async () => {
    const curve = type === 'ed25519' ? ed25519 : p256;
    const publicKey = curve.getPublicKey(secret);
    const account = createSSHAccount(type, publicKey);
    let checks = 0;
    const applet = {
      async viewKey() {
        return {publicKey};
      },
      async sign(request) {
        if (type === 'ed25519') {
          assert.deepEqual(request.message, bytes);
          assert.equal(request.digest, undefined);
          return {signature: ed25519.sign(request.message, secret)};
        }
        assert.deepEqual(request.digest, sha256(bytes));
        assert.equal(request.message, undefined);
        return {
          signature: p256
            .sign(request.digest, secret, {prehash: false})
            .toCompactRawBytes(),
        };
      },
    };
    const result = await signSSHData(
      applet,
      {account, type: type === 'p256' ? 'secp256r1' : type, index: '01020304'},
      paramsFor(account),
      () => {
        checks++;
      },
    );
    assert.ok(checks >= 3);
    assert.ok(verifySSHSignature(account, bytes, decodeBase64(result)));
  });
}

test('wrong card public key is rejected before signing', async () => {
  const publicKey = ed25519.getPublicKey(secret);
  const account = createSSHAccount('ed25519', publicKey);
  let signed = false;
  await assert.rejects(
    signSSHData(
      {
        async viewKey() {
          return {publicKey: ed25519.getPublicKey(new Uint8Array(32).fill(9))};
        },
        async sign() {
          signed = true;
        },
      },
      {account, type: 'ed25519', index: '01020304'},
      paramsFor(account),
      () => {},
    ),
    {code: -32003},
  );
  assert.equal(signed, false);
});

test('SSH proposal advertises only the approved key and method', () => {
  const account = createSSHAccount('ed25519', ed25519.getPublicKey(secret));
  const proposal = {
    params: {
      requiredNamespaces: {
        monoid: {
          chains: ['monoid:ssh'],
          methods: ['monoid_sshSign'],
          events: ['accountsChanged'],
        },
      },
      optionalNamespaces: {},
    },
  };
  assert.equal(requestsSSHAccounts(proposal), true);
  assert.deepEqual(buildWalletConnectNamespaces(proposal, [account]).monoid, {
    chains: ['monoid:ssh'],
    accounts: [account],
    methods: ['monoid_sshSign'],
    events: ['accountsChanged'],
  });
  proposal.params.requiredNamespaces.monoid.methods.push('monoid_signAnything');
  assert.throws(() => buildWalletConnectNamespaces(proposal, [account]));
});

test('review recognizes userauth and SSHSIG without claiming verified hostnames', () => {
  const account = createSSHAccount('ed25519', ed25519.getPublicKey(secret));
  const key = parseSSHAccount(account);
  const auth = Buffer.concat([
    string(new Uint8Array(32)),
    new Uint8Array([50]),
    string('alice'),
    string('ssh-connection'),
    string('publickey'),
    new Uint8Array([1]),
    string(key.algorithm),
    string(key.keyBlob),
  ]);
  const review = reviewSSHData(paramsFor(account, auth));
  assert.equal(review.title, 'SSH authentication');
  assert.match(review.notice, /cannot verify the destination hostname/);
  const file = Buffer.concat([
    Buffer.from('SSHSIG'),
    string('git'),
    string(''),
    string('sha512'),
    string(new Uint8Array(64)),
  ]);
  assert.equal(reviewSSHData(paramsFor(account, file)).title, 'Sign SSH data');
  assert.equal(
    reviewSSHData(paramsFor(account)).title,
    'Sign unknown SSH data',
  );
  assert.equal(
    reviewSSHData(
      paramsFor(account, Buffer.concat([auth, new Uint8Array([0])])),
    ).title,
    'Sign unknown SSH data',
  );
});
