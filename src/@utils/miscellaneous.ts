export function hexToUint8Array(hex: string): Uint8Array {
  const bytes =
    hex.match(/[0-9a-f]{2}/gi)?.map(byte => parseInt(byte, 16)) ?? [];

  return new Uint8Array(bytes);
}
