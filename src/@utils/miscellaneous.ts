export function hexToUint8Array(hex: string): Uint8Array {
  const bytes =
    hex.match(/[0-9a-f]{2}/gi)?.map(byte => parseInt(byte, 16)) ?? [];

  return new Uint8Array(bytes);
}

export function uint8ArrayToHex(uint8Array: Uint8Array): string {
  return Array.from(uint8Array, byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
