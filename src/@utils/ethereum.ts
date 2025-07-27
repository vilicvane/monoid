import {computeAddress} from 'ethers';

import type {EthereumAddress} from '../@atomics.js';

export function computeEthereumAddress(publicKey: string): EthereumAddress;
export function computeEthereumAddress(publicKey: string): string {
  return computeAddress(publicKey);
}
