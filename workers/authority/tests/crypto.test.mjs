import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  createECDH,
  createHmac,
  createHash,
  createDecipheriv,
} from 'node:crypto';
import {AuthorityCrypto} from '../.bld/crypto.js';

const cat = (...parts) =>
  Buffer.concat(
    parts.map(p => (typeof p === 'string' ? Buffer.from(p) : Buffer.from(p))),
  );
const sha = value => createHash('sha256').update(value).digest();
const mac = (key, value) =>
  createHmac('sha256', Buffer.from(key)).update(value).digest();
const b64 = value => Buffer.from(value, 'base64url');
const kem = cat('KEM', [0, 16]);
const suite = cat('HPKE', [0, 16, 0, 1, 0, 1]);
const extract = (id, salt, label, input) =>
  mac(salt, cat('HPKE-v1', id, label, input));
// RFC 9180 independent receiver: HKDF outputs here are all <= one SHA256 block.
const expand = (id, key, label, info, length) =>
  mac(
    key,
    cat([length >> 8, length & 255], 'HPKE-v1', id, label, info, [1]),
  ).subarray(0, length);

function decrypt(packet, recipient, sender) {
  const data = b64(packet.data);
  assert.equal(data.length, 182);
  assert.deepEqual(
    data.subarray(0, 4),
    Buffer.from([1, packet.allowPeerExtension ? 3 : 2, 0, 1]),
  );
  const header = data.subarray(0, 69);
  const enc = data.subarray(69, 134);
  const dh = cat(recipient.computeSecret(enc), recipient.computeSecret(sender));
  const eae = extract(kem, [], 'eae_prk', dh);
  const secret = expand(
    kem,
    eae,
    'shared_secret',
    cat(enc, recipient.getPublicKey(), sender),
    32,
  );
  const info = sha(cat('Monoid Authority Bundle', header));
  const context = cat(
    [2],
    extract(suite, [], 'psk_id_hash', []),
    extract(suite, [], 'info_hash', info),
  );
  const prk = extract(suite, secret, 'secret', []);
  const key = expand(suite, prk, 'key', context, 16);
  const nonce = expand(suite, prk, 'base_nonce', context, 12);
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(data.subarray(166));
  return cat(decipher.update(data.subarray(134, 166)), decipher.final());
}

test('Java Card wire packet independently decrypts; group roots stable and isolated', async () => {
  const authority = await AuthorityCrypto.create(
    await AuthorityCrypto.generateMaterial(),
  );
  const recipient = createECDH('prime256v1');
  recipient.generateKeys();
  const other = createECDH('prime256v1');
  other.generateKeys();
  const owner = {source: 'reown', id: 'project:profile'};
  const first = await authority.issueBundle(
    owner,
    'family',
    false,
    recipient.getPublicKey(),
  );
  const second = await authority.issueBundle(
    owner,
    'family',
    false,
    other.getPublicKey(),
  );
  const root = decrypt(first, recipient, b64(first.publicKey));
  assert.deepEqual(decrypt(second, other, b64(second.publicKey)), root);
  assert.equal(sha(root).toString('base64url'), first.bundle);
  for (const [o, name, policy] of [
    [owner, 'work', false],
    [owner, 'family', true],
    [{source: 'wallet', id: owner.id}, 'family', false],
    [{source: 'github-organization', id: '42'}, 'family', false],
  ]) {
    assert.notEqual(
      (await authority.issueBundle(o, name, policy, recipient.getPublicKey()))
        .bundle,
      first.bundle,
    );
  }
  assert.throws(() => decrypt(first, other, b64(first.publicKey)));
  assert.throws(() => decrypt(first, recipient, other.getPublicKey()));
  const tampered = b64(first.data);
  tampered[1] ^= 1;
  assert.throws(() =>
    decrypt(
      {
        ...first,
        allowPeerExtension: true,
        data: tampered.toString('base64url'),
      },
      recipient,
      b64(first.publicKey),
    ),
  );
});

test('time proof binds domain, challenge and big-endian timestamp with P1363 signature', async () => {
  const authority = await AuthorityCrypto.create(
    await AuthorityCrypto.generateMaterial(),
  );
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const proof = await authority.issueTime(challenge, 1792720500123);
  const data = b64(proof.data);
  assert.equal(data.length, 41);
  assert.equal(data.readBigUInt64BE(1), 1792720500n);
  assert.deepEqual(data.subarray(9), Buffer.from(challenge));
  assert.equal(b64(proof.signature).length, 64);
  const key = await crypto.subtle.importKey(
    'raw',
    b64(proof.publicKey),
    {name: 'ECDSA', namedCurve: 'P-256'},
    false,
    ['verify'],
  );
  const verify = input =>
    crypto.subtle.verify(
      {name: 'ECDSA', hash: 'SHA-256'},
      key,
      b64(proof.signature),
      input,
    );
  assert.equal(await verify(cat('Monoid Authority Time', data)), true);
  assert.equal(await verify(data), false);
  data[40] ^= 1;
  assert.equal(await verify(cat('Monoid Authority Time', data)), false);
});
