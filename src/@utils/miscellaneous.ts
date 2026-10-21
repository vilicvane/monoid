import type {TransformNominal} from '../@x-value/index.js';

/** Unlike randomUUID, getRandomValues is available in HTTP WebViews. */
export function createFlowId(): string {
  return crypto.getRandomValues(new Uint32Array(4)).join('-');
}

export function hexToUint8Array<T extends string>(
  hex: T,
): TransformNominal<T, Uint8Array, '- hex'>;
export function hexToUint8Array(hex: string): Uint8Array {
  const bytes =
    hex.match(/[0-9a-f]{2}/gi)?.map(byte => parseInt(byte, 16)) ?? [];

  return new Uint8Array(bytes);
}

export function uint8ArrayToHex<T extends Uint8Array>(
  uint8Array: T,
): TransformNominal<T, string, '+ hex'>;
export function uint8ArrayToHex(uint8Array: Uint8Array): string {
  return Array.from(uint8Array, byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
