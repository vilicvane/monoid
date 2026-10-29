import {decode} from './encoding.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function requireValue(
  condition: unknown,
  code = 'invalid_request',
): asserts condition {
  if (!condition) {
    throw new HttpError(400, code);
  }
}

export function string(value: unknown, maxLength = 256): string {
  requireValue(
    typeof value === 'string' && value.length > 0 && value.length <= maxLength,
  );
  return value;
}

export function bytes(value: unknown, length: number): Uint8Array {
  const text = string(value, Math.ceil((length * 4) / 3));

  try {
    const result = decode(text);
    requireValue(result.length === length);
    return result;
  } catch {
    throw new HttpError(400, 'invalid_encoding');
  }
}

export async function body(
  request: Request,
  maxLength = 4096,
): Promise<Record<string, unknown>> {
  requireValue(
    request.headers.get('Content-Type')?.split(';')[0] === 'application/json',
  );
  const reader = request.body?.getReader();
  requireValue(reader);

  const chunks: Uint8Array[] = [];
  let length = 0;

  while (true) {
    const {value, done} = await reader.read();
    if (done) break;

    length += value.length;
    if (length > maxLength) {
      await reader.cancel();
      throw new HttpError(413, 'request_too_large');
    }
    chunks.push(value);
  }

  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }

  try {
    const result: unknown = JSON.parse(new TextDecoder().decode(data));
    requireValue(
      result && typeof result === 'object' && !Array.isArray(result),
    );
    return result as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

export const json = (value: unknown, status = 200): Response =>
  Response.json(value, {status});

export function redirect(url: string, cookie?: string): Response {
  const headers = new Headers({Location: url});
  if (cookie) headers.set('Set-Cookie', cookie);
  return new Response(null, {status: 303, headers});
}
