import {
  Signature,
  computeAddress,
  getAddress,
  getBytes,
  hashMessage,
  hexlify,
  recoverAddress,
} from 'ethers';

import type {MonoidApplet, MonoidAppletKey} from './monoid-applet.js';

export async function signEvmMessage(
  applet: MonoidApplet,
  key: MonoidAppletKey,
  message: string,
  expectedAddress: string,
): Promise<string> {
  const address = getAddress(expectedAddress);
  const {publicKey} = await applet.viewKey(key);

  if (computeAddress(hexlify(publicKey)) !== address) {
    throw new Error('This card does not contain the selected account.');
  }

  const digest = hashMessage(message);
  const {signature} = await applet.sign({
    ...key,
    cipher: 'ecdsa',
    digest: getBytes(digest),
  });

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
