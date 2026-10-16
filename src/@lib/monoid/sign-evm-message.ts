import {hashMessage} from 'ethers';

import type {MonoidApplet, MonoidAppletKey} from './monoid-applet.js';
import {signEvmDigest} from './sign-evm-digest.js';

export async function signEvmMessage(
  applet: MonoidApplet,
  key: MonoidAppletKey,
  message: string | Uint8Array,
  expectedAddress: string,
  assertActive?: () => void,
): Promise<string> {
  return signEvmDigest(
    applet,
    key,
    hashMessage(message),
    expectedAddress,
    assertActive,
  );
}
