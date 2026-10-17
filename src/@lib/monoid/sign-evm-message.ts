import {hashMessage} from 'ethers';

import type {MonoidApplet, MonoidAppletSECP256K1Key} from './monoid-applet.js';
import {signEvmDigest} from './sign-evm-digest.js';

export async function signEvmMessage(
  applet: MonoidApplet,
  key: MonoidAppletSECP256K1Key,
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
