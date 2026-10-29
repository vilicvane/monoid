import {base58} from '@scure/base';

import {CardItemNotFoundError} from '../cbor-applet.js';
import {verifySolanaSignature} from '../solana-signature.js';

import {MonoidCardError} from './card-error.js';
import type {MonoidApplet, MonoidAppletED25519Key} from './monoid-applet.js';

const ACCOUNT_NOT_FOUND_MESSAGE = 'Account not on this card';

export async function signSolanaMessage(
  applet: MonoidApplet,
  key: MonoidAppletED25519Key,
  message: Uint8Array,
  expectedAddress: string,
  assertActive?: () => void,
): Promise<string> {
  assertActive?.();

  const messageBytes = message.slice();
  const {publicKey} = await applet.viewKey(key).catch(handleSigningError);

  assertActive?.();

  if (publicKey.length !== 32 || base58.encode(publicKey) !== expectedAddress) {
    throw new MonoidCardError(ACCOUNT_NOT_FOUND_MESSAGE);
  }

  const {signature} = await applet
    .sign({
      ...key,
      cipher: 'ed25519',
      message: messageBytes,
    })
    .catch(handleSigningError);

  assertActive?.();

  if (signature.length !== 64) {
    throw new Error('Invalid ed25519 signature length.');
  }

  const result = base58.encode(signature);

  if (!verifySolanaSignature(messageBytes, result, expectedAddress)) {
    throw new Error('The signature does not match the selected account.');
  }

  return result;
}

function handleSigningError(error: unknown): never {
  if (error instanceof CardItemNotFoundError) {
    throw new MonoidCardError(ACCOUNT_NOT_FOUND_MESSAGE, {cause: error});
  }

  throw error;
}
