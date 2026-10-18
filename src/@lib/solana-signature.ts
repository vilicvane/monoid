import {ed25519} from '@noble/curves/ed25519.js';
import {base58} from '@scure/base';

export function verifySolanaSignature(
  message: Uint8Array,
  signature: string,
  address: string,
): boolean {
  try {
    const signatureBytes = base58.decode(signature);
    const publicKey = base58.decode(address);

    return (
      signatureBytes.length === 64 &&
      publicKey.length === 32 &&
      ed25519.verify(signatureBytes, message, publicKey, {zip215: false})
    );
  } catch {
    return false;
  }
}
