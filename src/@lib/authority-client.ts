import {base64urlnopad} from '@scure/base';
import {getBytes, sha256, toUtf8Bytes} from 'ethers';
import * as x from 'x-value';

export const AUTHORITY_CALLBACK_URI = 'app.monoid://authority/callback';
export const AUTHORITY_LOGIN_TTL = 10 * 60 * 1000;

const messages = {
  cancelled: 'Authority sign-in cancelled',
  expired: 'Authority sign-in expired',
  invalid_callback: 'Invalid authority sign-in callback',
  unauthorized: 'Authority session expired. Sign in again.',
  bundle_policy_conflict: 'A bundle with this name has a different policy.',
  rate_limited: 'Too many authority requests. Try again later.',
  network_error: 'Could not connect to the authority.',
  service_error: 'Authority request failed.',
} as const;

export class AuthorityError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}

export const AuthorityAccount = x.object({
  source: x.union([
    x.literal('google'),
    x.literal('github-user'),
    x.literal('wallet'),
  ]),
  id: x.string,
  displayName: x.string,
});
export type AuthorityAccount = x.TypeOf<typeof AuthorityAccount>;
export const AuthorityOwner = x.object({
  source: x.union([
    x.literal('google'),
    x.literal('wallet'),
    x.literal('github-user'),
    x.literal('github-organization'),
  ]),
  id: x.string,
});
export type AuthorityOwner = x.TypeOf<typeof AuthorityOwner>;
export const AuthorityNamespace = x.intersection([
  AuthorityOwner,
  x.object({displayName: x.string}),
]);
export type AuthorityNamespace = x.TypeOf<typeof AuthorityNamespace>;
export const AuthorityGroup = x.object({
  name: x.string,
  allowPeerExtension: x.boolean,
  createdAt: x.number,
});
export type AuthorityGroup = x.TypeOf<typeof AuthorityGroup>;

export function validateAuthorityBundleName(value: string): string {
  const name = value.normalize('NFC');
  if (
    value.length > 128 ||
    name.trim() !== name ||
    /[\p{Cc}\p{Cf}]/u.test(name) ||
    new TextEncoder().encode(name).length > 128
  )
    throw new Error(
      'Use a bundle name of up to 128 UTF-8 bytes, without surrounding spaces or control characters.',
    );
  return name;
}

export const AuthorityMetadata = x.object({
  publicKey: x.string,
  bundle: x.literal('hpke-auth-p256-sha256-aes128gcm'),
  time: x.object({
    protocol: x.literal('monoid-authority-time'),
    version: x.literal(1),
    algorithm: x.literal('ecdsa-p256-sha256-p1363'),
  }),
});
export type AuthorityMetadata = Omit<
  x.TypeOf<typeof AuthorityMetadata>,
  'publicKey'
> & {
  publicKey: Uint8Array;
};
export const AuthorityBundle = x.object({
  publicKey: x.string,
  data: x.string,
  bundle: x.string,
  owner: AuthorityOwner,
  groupName: x.string,
  allowPeerExtension: x.boolean,
});
export type AuthorityBundle = Omit<
  x.TypeOf<typeof AuthorityBundle>,
  'publicKey' | 'data' | 'bundle'
> & {publicKey: Uint8Array; data: Uint8Array; bundle: Uint8Array};

export const AuthorityPendingLogin = x.object({
  authorityUrl: x.string,
  state: x.string,
  codeVerifier: x.string,
  expiresAt: x.number,
});
export type AuthorityPendingLogin = x.TypeOf<typeof AuthorityPendingLogin>;

export function authorityRandomToken(): string {
  return base64urlnopad.encode(crypto.getRandomValues(new Uint8Array(32)));
}

/** Also works in the HTTP development WebView, without crypto.subtle. */
export function authorityPKCEChallenge(verifier: string): string {
  return base64urlnopad.encode(getBytes(sha256(toUtf8Bytes(verifier))));
}

export function authorityBytes(value: string, length: number): Uint8Array {
  try {
    const bytes = base64urlnopad.decode(value);
    if (bytes.length === length && base64urlnopad.encode(bytes) === value)
      return bytes;
  } catch {
    // Do not include server payloads in errors.
  }
  throw new AuthorityError('service_error');
}

/** Unrelated or malformed links must not consume a legitimate pending login. */
export function authorityCallback(value: string, state: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthorityError('invalid_callback');
  }
  const params = url.searchParams;
  const code = params.get('code');
  const error = params.get('error');
  if (
    url.href.split('?')[0] !== AUTHORITY_CALLBACK_URI ||
    url.href.includes('#') ||
    params.getAll('state').length !== 1 ||
    params.get('state') !== state ||
    [...params.keys()].some(key => !['state', 'code', 'error'].includes(key)) ||
    params.getAll('code').length + params.getAll('error').length !== 1
  )
    throw new AuthorityError('invalid_callback');
  if (error === 'access_denied') throw new AuthorityError('cancelled');
  if (!code || !/^[A-Za-z0-9_-]{43}$/.test(code))
    throw new AuthorityError('invalid_callback');
  return code;
}
