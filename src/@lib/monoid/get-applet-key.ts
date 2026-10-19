import type {BIP39PathString, SafeIndexHex} from '../../@atomics.js';
import {hexToUint8Array} from '../../@utils/index.js';
import {parseDerivationPath} from '../bip39.js';
import type {AddressType} from '../wallet-address.js';

import type {
  MonoidAppletED25519Key,
  MonoidAppletKey,
  MonoidAppletSECP256K1Key,
} from './monoid-applet.js';

type Key = {type: string; index: SafeIndexHex};

export function getAppletKey(
  key: Key,
  addressType: Exclude<AddressType, 'solana'>,
  path?: BIP39PathString,
): MonoidAppletSECP256K1Key;
export function getAppletKey(
  key: Key,
  addressType: 'solana',
  path?: BIP39PathString,
): MonoidAppletED25519Key;
export function getAppletKey(
  key: Key,
  addressType: AddressType,
  path?: BIP39PathString,
): MonoidAppletKey;
export function getAppletKey(
  key: Key,
  addressType: AddressType,
  path?: BIP39PathString,
): MonoidAppletKey {
  const index = hexToUint8Array(key.index);
  const curve = addressType === 'solana' ? 'ed25519' : 'secp256k1';

  if (key.type === 'seed') {
    if (path === undefined) {
      throw new Error('A derived wallet requires a derivation path.');
    }

    const derivedPath = parseDerivationPath(path);

    return curve === 'ed25519'
      ? {
          type: key.type,
          index,
          derivation: {type: 'slip10', curve, path: derivedPath},
        }
      : {
          type: key.type,
          index,
          derivation: {type: 'bip32', path: derivedPath},
        };
  }

  if (key.type !== curve) {
    throw new Error(
      `Address type ${addressType} is not supported by ${key.type}.`,
    );
  }

  return {type: curve, index};
}
