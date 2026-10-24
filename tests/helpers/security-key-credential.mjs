import {p256} from '@noble/curves/nist';
import {encode} from 'cbor2';
import {getBytes, sha256, toUtf8Bytes} from 'ethers';

const hex = value => Buffer.from(value).toString('hex');

/** Independent registrations deliberately share the same RP and user. */
export function credential(number, options = {}) {
  const {scope = 1, fields: changes = [], ...overrides} = options;
  const credentialId = Uint8Array.from(
    Buffer.from(number.toString(16).padStart(16, '0') + '11'.repeat(24), 'hex'),
  );
  const rpHash = getBytes(sha256(toUtf8Bytes('example.com')));
  const scopeBytes = new Uint8Array(32).fill(scope);
  const fields = new Map([
    [1, 1],
    [2, credentialId],
    [3, rpHash],
    [4, 'example.com'],
    [5, new Uint8Array([1, 2, 3, 4])],
    [6, 'alice'],
    [7, 'Alice'],
    [8, true],
    [9, p256.getPublicKey(1n, false)],
    [10, scopeBytes],
  ]);
  for (const [field, value] of changes) {
    if (value === undefined) fields.delete(field);
    else fields.set(field, value);
  }
  return {
    index: `f101${hex(credentialId.subarray(0, 8))}`,
    secret: false,
    metadata: hex(Uint8Array.from([...scopeBytes, ...rpHash])),
    data: hex(encode(fields)),
    ...overrides,
  };
}
