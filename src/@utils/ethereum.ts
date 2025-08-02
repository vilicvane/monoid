import {computeAddress} from 'ethers';

import type {EthereumAddress, PublicKeyHex} from '../@atomics.js';

export function computeEthereumAddress(
  publicKey: PublicKeyHex,
): EthereumAddress;
export function computeEthereumAddress(publicKey: PublicKeyHex): string {
  return computeAddress(`0x${publicKey}`);
}
