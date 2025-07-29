export const ETHEREUM_SEED = 'Bitcoin seed';

export const ETHEREUM_CURVE = 'secp256k1';

export function ETHEREUM_DERIVATION_PATH(index = 0): string {
  return `m/44'/60'/0'/0/${index}`;
}
