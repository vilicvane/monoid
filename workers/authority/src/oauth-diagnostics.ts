type Provider = 'google' | 'github';

const MAX_ERROR_BODY = 16384;

async function errorFields(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const decoder = new TextDecoder();
  let text = '',
    length = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_ERROR_BODY) {
        void reader.cancel().catch(() => {});
        return {};
      }
      text += decoder.decode(value, {stream: true});
    }
    text += decoder.decode();
    try {
      return JSON.parse(text);
    } catch {
      const form = new URLSearchParams(text);
      return Object.fromEntries(form);
    }
  } catch {
    return {};
  } finally {
    reader.releaseLock();
  }
}

export function warnTokenError(
  provider: Provider,
  status: number,
  body: unknown,
  credentials: string[],
) {
  const fields: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const sensitive = [...credentials];
  for (const key of [
    'code',
    'code_verifier',
    'client_secret',
    'access_token',
    'id_token',
    'refresh_token',
  ]) {
    if (typeof fields[key] === 'string') sensitive.push(fields[key]);
  }
  const redactions = sensitive
    .filter(Boolean)
    .flatMap(value => {
      try {
        return [value, encodeURIComponent(value)];
      } catch {
        return [value];
      }
    })
    .sort((a, b) => b.length - a.length);
  const clean = (value: unknown, limit: number) => {
    if (typeof value !== 'string') return undefined;
    let text = value;
    for (const secret of redactions)
      text = text.replaceAll(secret, '[redacted]');
    return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, limit);
  };
  console.warn(
    '[oauth] ' +
      JSON.stringify({
        provider,
        status,
        error: clean(fields.error, 128),
        error_description: clean(fields.error_description, 512),
      }),
  );
}

export async function warnTokenResponse(
  provider: Provider,
  response: Response,
  credentials: string[],
) {
  warnTokenError(
    provider,
    response.status,
    await errorFields(response),
    credentials,
  );
}
