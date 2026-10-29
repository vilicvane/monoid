export const utf8 = (value: string): Uint8Array =>
  new TextEncoder().encode(value);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

export function encode(value: Uint8Array | ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid base64url');
  }

  const result = Uint8Array.from(
    atob(value.replaceAll('-', '+').replaceAll('_', '/')),
    char => char.charCodeAt(0),
  );

  if (encode(result) !== value) {
    throw new Error('Noncanonical base64url');
  }

  return result;
}

export async function hash(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', value));
}

export const randomToken = (): string =>
  encode(crypto.getRandomValues(new Uint8Array(32)));
export const tokenHash = async (value: string): Promise<string> =>
  encode(await hash(utf8(value)));
