import type {CloudKVErrorCode} from './definitions.js';
import {CLOUD_KV_LIMITS} from './definitions.js';

export function cloudKVError(code: CloudKVErrorCode, message: string): Error {
  return Object.assign(new Error(message), {code});
}

export function validateKey(key: unknown): string {
  if (typeof key !== 'string' || key === '') {
    throw cloudKVError('INVALID_ARGUMENT', 'Key must be a nonempty string.');
  }

  validateText(key, 'Key');

  if (utf8Length(key) > CLOUD_KV_LIMITS.maxKeyBytes) {
    throw cloudKVError(
      'INVALID_ARGUMENT',
      `Key must be at most ${CLOUD_KV_LIMITS.maxKeyBytes} UTF-8 bytes.`,
    );
  }

  return key;
}

export function validateValue(value: unknown): string {
  if (typeof value !== 'string') {
    throw cloudKVError('INVALID_ARGUMENT', 'Value must be a string.');
  }

  validateText(value, 'Value');

  return value;
}

export function validatePrefix(prefix: unknown): string {
  if (prefix === undefined) {
    return '';
  }

  if (typeof prefix !== 'string') {
    throw cloudKVError('INVALID_ARGUMENT', 'Prefix must be a string.');
  }

  validateText(prefix, 'Prefix');

  return prefix;
}

/** Throws QUOTA_EXCEEDED when replacing `key` with `value` would exceed the limits. */
export function checkQuota(
  entries: Iterable<[string, string]>,
  key: string,
  value: string,
): void {
  let count = 1;
  let bytes = utf8Length(key) + utf8Length(value);

  for (const [entryKey, entryValue] of entries) {
    if (entryKey === key) {
      continue;
    }

    count++;
    bytes += utf8Length(entryKey) + utf8Length(entryValue);
  }

  if (count > CLOUD_KV_LIMITS.maxKeys) {
    throw cloudKVError(
      'QUOTA_EXCEEDED',
      `At most ${CLOUD_KV_LIMITS.maxKeys} keys can be stored.`,
    );
  }

  if (bytes > CLOUD_KV_LIMITS.maxTotalBytes) {
    throw cloudKVError(
      'QUOTA_EXCEEDED',
      `Stored keys and values must total at most ${CLOUD_KV_LIMITS.maxTotalBytes} UTF-8 bytes.`,
    );
  }
}

export function utf8Length(text: string): number {
  let length = 0;

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);

    if (code < 0x80) {
      length += 1;
    } else if (code < 0x800) {
      length += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // Validated text pairs every high surrogate with a low surrogate.
      length += 4;
      index++;
    } else {
      length += 3;
    }
  }

  return length;
}

// Unpaired UTF-16 surrogates cannot cross the native bridge unchanged.
function validateText(text: string, name: string): void {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);

      if (next >= 0xdc00 && next <= 0xdfff) {
        index++;
        continue;
      }
    } else if (code < 0xdc00 || code > 0xdfff) {
      continue;
    }

    throw cloudKVError(
      'INVALID_ARGUMENT',
      `${name} contains an unpaired UTF-16 surrogate.`,
    );
  }
}
