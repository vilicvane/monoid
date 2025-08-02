import type {BIP39PathString} from './@atomics.js';
import {BIP39Seed, CurveName} from './@atomics.js';

export const ETHEREUM_SEED = BIP39Seed.satisfies('Bitcoin seed');

export const ETHEREUM_CURVE = CurveName.satisfies('secp256k1');

export function ETHEREUM_DERIVATION_PATH(index?: number): BIP39PathString;
export function ETHEREUM_DERIVATION_PATH(index = 0): string {
  return `m/44'/60'/0'/0/${index}`;
}
