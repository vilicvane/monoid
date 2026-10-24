import {p256} from '@noble/curves/nist';
import {base64urlnopad} from '@scure/base';

import {hexToUint8Array} from '../@utils/index.js';

import type {IdentityInstallationOptions} from './monoid/install.js';
import {authorityApiUrl, normalizeAuthorityUrl} from './authority-url.js';

/** Defaults are editable before installing Identity; existing cards keep their trust. */
export function getDefaultOTPAuthorityUrl(): string {
  return import.meta.env?.VITE_AUTHORITY_URL ?? '';
}

/** Warm the public service while PIN input and NFC are still in progress. */
export class OTPAuthorityWarmup {
  private controller = new AbortController();
  private urls = new Set<string>();

  constructor(private signal: AbortSignal) {}

  start(value: string | false | undefined): void {
    if (!value || this.signal.aborted || this.controller.signal.aborted) return;
    void this.connect(value).catch(() => {
      // A hint is optional; only the tapped card's signed-time request can fail
      // the operation. Never use metadata to choose its time mode or trust key.
    });
  }

  stop(): void {
    this.controller.abort();
  }

  private async connect(value: string): Promise<void> {
    const url = authorityApiUrl(value, 'v1/metadata');
    if (this.urls.has(url)) return;
    this.urls.add(url);
    const response = await fetch(url, {
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.any([
        this.signal,
        this.controller.signal,
        AbortSignal.timeout(10_000),
      ]),
    });
    // Consume the response so the connection can be reused. Its key and content
    // are deliberately not used for authentication or installation.
    await response.arrayBuffer();
  }
}

/** Resolve public trust before PIN input or NFC; never downgrade after a failure. */
export async function resolveOTPAuthorityInstallationOptions(
  value: string,
  signal: AbortSignal,
): Promise<IdentityInstallationOptions> {
  signal.throwIfAborted();
  if (!value.trim()) return {};
  const authorityUrl = normalizeAuthorityUrl(value);
  if (new TextEncoder().encode(authorityUrl).length > 146)
    throw new Error('Authority URL is too long');
  const configuredKey = import.meta.env?.VITE_AUTHORITY_PUBLIC_KEY;
  const configuredUrl = getDefaultOTPAuthorityUrl();
  let authorityPublicKey: Uint8Array;
  if (
    configuredKey &&
    configuredUrl &&
    authorityUrl === normalizeAuthorityUrl(configuredUrl)
  ) {
    if (!/^04[0-9a-f]{128}$/i.test(configuredKey))
      throw new Error('Invalid Authority public key');
    authorityPublicKey = hexToUint8Array(configuredKey);
  } else {
    let metadata: {publicKey?: unknown};
    try {
      const response = await fetch(
        authorityApiUrl(authorityUrl, 'v1/metadata'),
        {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        },
      );
      if (!response.ok) throw new Error();
      metadata = await response.json();
    } catch {
      signal.throwIfAborted();
      throw new Error('Could not connect to Authority');
    }
    try {
      if (typeof metadata?.publicKey !== 'string') throw new Error();
      authorityPublicKey = base64urlnopad.decode(metadata.publicKey);
    } catch {
      throw new Error('Invalid Authority public key');
    }
  }
  signal.throwIfAborted();
  try {
    if (authorityPublicKey.length !== 65 || authorityPublicKey[0] !== 4)
      throw new Error();
    p256.Point.fromHex(authorityPublicKey).assertValidity();
  } catch {
    throw new Error('Invalid Authority public key');
  }
  return {authorityUrl, authorityPublicKey};
}
