import {
  Signature,
  computeAddress,
  getAddress,
  getBytes,
  hexlify,
  recoverAddress,
} from 'ethers';

import {CBORAppletError} from '../cbor-applet.js';

import {MonoidCardError} from './card-error.js';
import type {MonoidApplet, MonoidAppletSECP256K1Key} from './monoid-applet.js';

const ACCOUNT_NOT_FOUND_MESSAGE = 'Account not on this card.';

export async function signEvmDigest(
  applet: MonoidApplet,
  key: MonoidAppletSECP256K1Key,
  digest: string,
  expectedAddress: string,
  assertActive?: () => void,
): Promise<string> {
  assertActive?.();

  const digestBytes = getBytes(digest);

  if (digestBytes.length !== 32) {
    throw new Error('Invalid EVM digest length.');
  }

  const address = getAddress(expectedAddress);
  const {publicKey} = await applet.viewKey(key).catch(handleSigningError);

  assertActive?.();

  if (computeAddress(hexlify(publicKey)) !== address) {
    throw new MonoidCardError(ACCOUNT_NOT_FOUND_MESSAGE);
  }

  const {signature} = await applet
    .sign({
      ...key,
      cipher: 'ecdsa',
      digest: digestBytes,
    })
    .catch(handleSigningError);

  assertActive?.();

  // The card returns low-S, plain r || s; Ethereum also needs the recovery bit.
  if (signature.length !== 64) {
    throw new Error('Invalid ECDSA signature length.');
  }

  const r = hexlify(signature.subarray(0, 32));
  const s = hexlify(signature.subarray(32));

  for (const v of [27, 28]) {
    const result = Signature.from({r, s, v});

    if (recoverAddress(digest, result) === address) {
      return result.serialized;
    }
  }

  throw new Error('The signature does not match the selected account.');
}

function handleSigningError(error: unknown): never {
  if (error instanceof CBORAppletError && error.source.code === 'NOT_FOUND') {
    throw new MonoidCardError(ACCOUNT_NOT_FOUND_MESSAGE, {cause: error});
  }
  throw error;
}
