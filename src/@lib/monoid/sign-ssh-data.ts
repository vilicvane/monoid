import {
  SSHProtocolError,
  type SSHSignParams,
  SSH_ERROR_CODES,
  createSSHAccount,
  decodeBase64,
  encodeBase64,
  encodeSSHSignature,
  sha256,
  verifySSHSignature,
} from '@monoid/ssh-protocol';

import type {SSHKeyData} from '../../@services/index.js';
import {hexToUint8Array} from '../../@utils/index.js';
import {CardItemNotFoundError} from '../cbor-applet.js';
import {getSeedDerivedAppletKey} from '../key-derivation.js';

import type {MonoidApplet} from './monoid-applet.js';

export async function signSSHData(
  applet: MonoidApplet,
  key: SSHKeyData,
  params: SSHSignParams,
  assertActive: () => void,
): Promise<string> {
  assertActive();
  if (key.account !== params.account)
    throw new SSHProtocolError(SSH_ERROR_CODES.unauthorized);
  const algorithm =
    key.type === 'seed'
      ? key.derivation.curve === 'ed25519'
        ? 'ed25519'
        : 'p256'
      : key.type === 'ed25519'
        ? 'ed25519'
        : 'p256';
  const reference =
    key.type === 'seed'
      ? getSeedDerivedAppletKey(key.index, key.derivation)
      : {type: key.type, index: hexToUint8Array(key.index)};
  try {
    const {publicKey} = await applet.viewKey(reference);
    assertActive();
    if (createSSHAccount(algorithm, publicKey) !== params.account)
      throw new SSHProtocolError(SSH_ERROR_CODES.keyUnavailable);
    const data = decodeBase64(params.data);
    let signature: Uint8Array;
    if (algorithm === 'ed25519') {
      if (reference.type === 'seed') {
        const derivation = reference.derivation;
        if (derivation.type !== 'monoid-001' || derivation.curve !== 'ed25519')
          throw new SSHProtocolError(SSH_ERROR_CODES.invalidParams);
        ({signature} = await applet.sign({
          type: 'seed',
          index: reference.index,
          derivation,
          cipher: 'ed25519',
          message: data,
        }));
      } else {
        ({signature} = await applet.sign({
          type: 'ed25519',
          index: reference.index,
          cipher: 'ed25519',
          message: data,
        }));
      }
    } else {
      if (reference.type === 'seed') {
        const derivation = reference.derivation;
        if (
          derivation.type !== 'monoid-001' ||
          derivation.curve !== 'secp256r1'
        )
          throw new SSHProtocolError(SSH_ERROR_CODES.invalidParams);
        ({signature} = await applet.sign({
          type: 'seed',
          index: reference.index,
          derivation,
          cipher: 'ecdsa',
          digest: sha256(data),
        }));
      } else {
        ({signature} = await applet.sign({
          type: 'secp256r1',
          index: reference.index,
          cipher: 'ecdsa',
          digest: sha256(data),
        }));
      }
    }
    assertActive();
    const blob = encodeSSHSignature(params.algorithm, signature);
    if (!verifySSHSignature(params.account, data, blob))
      throw new SSHProtocolError(SSH_ERROR_CODES.signingFailed);
    return encodeBase64(blob);
  } catch (error) {
    if (error instanceof CardItemNotFoundError)
      throw new SSHProtocolError(SSH_ERROR_CODES.keyUnavailable);
    throw error;
  }
}
