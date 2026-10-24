import {p256} from '@noble/curves/nist';
import {base32, base32nopad, base64urlnopad} from '@scure/base';
import {getBytes, sha256, toUtf8Bytes} from 'ethers';

import {SafeIndex, SafeIndexHex} from '../@atomics.js';
import {uint8ArrayToHex} from '../@utils/index.js';

import {authorityApiUrl} from './authority-url.js';
import {InvalidCardItemError} from './card-item-error.js';
import {equalBytes} from './global-platform/commands.js';
import type {MonoidApplet} from './monoid/index.js';
import {MonoidCardError} from './monoid/index.js';
import {type OTPApplet, createOTPApplet} from './otp-applet.js';

export {OTP_AID} from './otp-applet.js';

export const OTP_ITEM_TYPE = 0xf201;
export const OTP_MAX_ACCOUNTS = 16;
export const OTP_BATCH_SIZE = 3;

// eslint-disable-next-line no-control-regex -- Account names reject ASCII control characters.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const algorithms = ['SHA1', 'SHA256', 'SHA512'] as const;
export type OTPAlgorithm = (typeof algorithms)[number];
export type OTPAccountConfiguration = {
  algorithm: OTPAlgorithm;
  digits: 6 | 8;
  period: number;
};
export type OTPImportAccount = OTPAccountConfiguration & {
  label: string;
  secret: Uint8Array;
};

/** Shared secrets stay in the import flow and are never part of cached accounts. */
export function decodeOTPSecret(input: string): Uint8Array {
  let value = input.replace(/\s/g, '').toUpperCase();
  let secret: Uint8Array;
  try {
    // Some providers generate Base32 symbols directly. Ignore unused final bits,
    // as Google Authenticator does, while retaining alphabet/length/padding checks.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const body = value.replace(/=+$/, '');
    const unusedBits = (body.length * 5) % 8;
    const last = alphabet.indexOf(body.slice(-1));
    if (unusedBits > 0 && unusedBits < 5 && last >= 0) {
      value =
        body.slice(0, -1) +
        alphabet[last & (31 << unusedBits)] +
        value.slice(body.length);
    }
    const coder = value.includes('=') ? base32 : base32nopad;
    secret = coder.decode(value);
    if (coder.encode(secret) !== value) throw new Error();
  } catch {
    throw new MonoidCardError('Invalid Base32 secret');
  }
  if (secret.length < 1 || secret.length > 255)
    throw new MonoidCardError('Secret must contain 1–255 bytes');
  return secret;
}

export function parseOTPURI(input: string): OTPImportAccount {
  let uri: URL;
  try {
    uri = new URL(input.trim());
  } catch {
    throw new MonoidCardError('Invalid OTP link');
  }
  if (uri.protocol !== 'otpauth:' || uri.hostname !== 'totp')
    throw new MonoidCardError('Only TOTP accounts are supported');
  if (uri.username || uri.password || uri.port || uri.hash)
    throw new MonoidCardError('Invalid OTP link');

  const fields = new Set(['secret', 'issuer', 'algorithm', 'digits', 'period']);
  for (const name of uri.searchParams.keys()) {
    if (!fields.has(name))
      throw new MonoidCardError(`Unsupported OTP option: ${name}`);
    if (uri.searchParams.getAll(name).length !== 1)
      throw new MonoidCardError('Duplicate OTP option');
  }

  let label: string;
  try {
    label = decodeURIComponent(uri.pathname.slice(1)).trim();
  } catch {
    throw new MonoidCardError('Invalid OTP account name');
  }
  if (!label || CONTROL_CHARACTER.test(label))
    throw new MonoidCardError('Invalid OTP account name');
  const issuer = uri.searchParams.get('issuer')?.trim();
  const separator = label.indexOf(':');
  if (issuer) {
    // Names are presentation metadata; preserve an explicit prefix even when
    // the issuer parameter uses a different spelling or service name.
    if (separator < 0) label = `${issuer}: ${label}`;
  }
  if (CONTROL_CHARACTER.test(label))
    throw new MonoidCardError('Invalid OTP account name');
  if (separator >= 0 && !label.slice(separator + 1).trim())
    throw new MonoidCardError('Invalid OTP account name');

  const algorithm = (uri.searchParams.get('algorithm') ?? 'SHA1').toUpperCase();
  if (!algorithms.some(value => value === algorithm))
    throw new MonoidCardError('Unsupported OTP algorithm');
  const digits = uri.searchParams.get('digits') ?? '6';
  if (digits !== '6' && digits !== '8')
    throw new MonoidCardError('OTP codes must contain 6 or 8 digits');
  const period = uri.searchParams.get('period') ?? '30';
  if (!/^[1-9]\d*$/.test(period) || Number(period) > 32767)
    throw new MonoidCardError('Invalid OTP period');

  return {
    label,
    secret: decodeOTPSecret(uri.searchParams.get('secret') ?? ''),
    algorithm: algorithm as OTPAlgorithm,
    digits: Number(digits) as 6 | 8,
    period: Number(period),
  };
}

export function encodeOTPConfiguration(
  configuration: OTPAccountConfiguration,
): Uint8Array {
  const algorithm = algorithms.indexOf(configuration.algorithm) + 1;
  if (
    !algorithm ||
    (configuration.digits !== 6 && configuration.digits !== 8) ||
    !Number.isInteger(configuration.period) ||
    configuration.period < 1 ||
    configuration.period > 32767
  )
    throw new MonoidCardError('Invalid OTP configuration');
  return new Uint8Array([
    1,
    algorithm,
    configuration.digits,
    configuration.period >> 8,
    configuration.period & 255,
  ]);
}

export function decodeOTPConfiguration(
  metadata: Uint8Array,
): OTPAccountConfiguration {
  if (
    metadata.length !== 5 ||
    metadata[0] !== 1 ||
    metadata[1] < 1 ||
    metadata[1] > 3 ||
    (metadata[2] !== 6 && metadata[2] !== 8)
  )
    throw new InvalidCardItemError('Invalid OTP configuration');
  const period = metadata[3] * 256 + metadata[4];
  if (period < 1 || period > 32767)
    throw new InvalidCardItemError('Invalid OTP configuration');
  return {algorithm: algorithms[metadata[1] - 1], digits: metadata[2], period};
}

export function decodeOTPKeyReference(data: Uint8Array): SafeIndexHex {
  if (data.length !== 10 || data[0] !== 5 || data[1] === 0)
    throw new InvalidCardItemError('Invalid OTP key reference');
  return SafeIndexHex.satisfies(uint8ArrayToHex(data));
}

export type OTPAuthority = {endpoint: string; publicKey: Uint8Array};
export type OTPTimeAnchor = {
  time: bigint;
  requestedAt: number;
  receivedAt: number;
  /** Monotonic start of `time`'s whole second; exact locally, estimated remotely. */
  secondStartedAt?: number;
};
export type OTPTimeProof = OTPTimeAnchor & {
  data: Uint8Array;
  signature: Uint8Array;
};

function decodeProofBytes(value: unknown, length: number): Uint8Array {
  if (typeof value !== 'string')
    throw new MonoidCardError('Invalid time response');
  try {
    const bytes = base64urlnopad.decode(value);
    if (bytes.length !== length || base64urlnopad.encode(bytes) !== value)
      throw new Error();
    return bytes;
  } catch {
    throw new MonoidCardError('Invalid time response');
  }
}

export function decodeOTPTimeProof(
  response: unknown,
  challenge: Uint8Array,
  publicKey?: Uint8Array,
): Pick<OTPTimeProof, 'data' | 'signature' | 'time'> {
  if (challenge.length !== 32 || !response || typeof response !== 'object')
    throw new MonoidCardError('Invalid time response');
  const fields = response as Record<string, unknown>;
  const key = decodeProofBytes(fields.publicKey, 65);
  const data = decodeProofBytes(fields.data, 41);
  const signature = decodeProofBytes(fields.signature, 64);
  if (
    key[0] !== 4 ||
    (publicKey && !equalBytes(key, publicKey)) ||
    data[0] !== 1 ||
    !equalBytes(data.subarray(9), challenge)
  )
    throw new MonoidCardError('Could not verify time');
  const domain = toUtf8Bytes('Monoid Authority Time');
  const message = new Uint8Array(domain.length + data.length);
  message.set(domain);
  message.set(data, domain.length);
  let valid = false;
  try {
    valid = p256.verify(signature, getBytes(sha256(message)), key, {
      lowS: false,
    });
  } catch {
    // Malformed points and signatures are the same invalid proof at this boundary.
  }
  if (!valid) throw new MonoidCardError('Could not verify time');
  return {
    data,
    signature,
    time: new DataView(data.buffer, data.byteOffset + 1, 8).getBigUint64(0),
  };
}

export async function fetchOTPTimeProof(
  challenge: Uint8Array,
  authority: {endpoint: string; publicKey?: Uint8Array},
  signal: AbortSignal,
): Promise<OTPTimeProof> {
  if (challenge.length !== 32)
    throw new MonoidCardError('Invalid OTP challenge');
  signal.throwIfAborted();
  const requestedAt = performance.now();
  const response = await fetch(authorityApiUrl(authority.endpoint, 'v1/time'), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({challenge: base64urlnopad.encode(challenge)}),
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw new MonoidCardError('Could not get verified time');
  const body: unknown = await response.json();
  const receivedAt = performance.now();
  signal.throwIfAborted();
  const proof = decodeOTPTimeProof(body, challenge, authority.publicKey);
  return {...proof, requestedAt, receivedAt};
}

function validateOTPSelection(indices: readonly Uint8Array[]): SafeIndex[] {
  if (indices.length < 1 || indices.length > OTP_MAX_ACCOUNTS)
    throw new MonoidCardError('Select 1–16 accounts');
  const unique = new Set<string>();
  return indices.map(index => {
    if (index.length !== 10 || index[0] !== 0xf2 || index[1] !== 1)
      throw new MonoidCardError('Invalid OTP account');
    const hex = uint8ArrayToHex(index);
    if (unique.has(hex)) throw new MonoidCardError('Duplicate OTP account');
    unique.add(hex);
    return SafeIndex.satisfies(index.slice());
  });
}

export type PreparedOTP = {
  applet: OTPApplet;
  indices: SafeIndex[];
  time: OTPTimeAnchor;
};

/** Authenticate for OTP only after this returns: Prepare revokes old permission. */
export async function prepareOTP(
  monoid: MonoidApplet,
  indices: readonly Uint8Array[],
  authority: string | false,
  signal: AbortSignal,
  onStage?: (stage: 'preparing' | 'time') => void,
): Promise<PreparedOTP> {
  const selected = validateOTPSelection(indices);
  signal.throwIfAborted();
  onStage?.('preparing');
  const applet = await createOTPApplet().useSession(monoid);
  signal.throwIfAborted();
  if (authority === false) {
    const requestedAt = performance.now();
    const wallTime = Date.now();
    const time = BigInt(Math.floor(wallTime / 1000));
    const receivedAt = performance.now();
    const encoded = new Uint8Array(8);
    new DataView(encoded.buffer).setBigUint64(0, time);
    await applet.prepare({time: encoded, indices: selected});
    signal.throwIfAborted();
    return {
      applet,
      indices: selected,
      time: {
        time,
        requestedAt,
        receivedAt,
        secondStartedAt: requestedAt - (wallTime % 1000),
      },
    };
  }
  const {challenge} = await applet.challenge({});
  signal.throwIfAborted();
  onStage?.('time');
  // Hello supplies the URL; Identity pins the key and verifies the proof in
  // Prepare. A valid service signature alone does not establish card trust.
  const proof = await fetchOTPTimeProof(
    challenge,
    {endpoint: authority},
    signal,
  );
  signal.throwIfAborted();
  onStage?.('preparing');
  await applet.prepare({
    data: proof.data,
    signature: proof.signature,
    indices: selected,
  });
  signal.throwIfAborted();
  return {
    applet,
    indices: selected,
    time: {
      time: proof.time,
      requestedAt: proof.requestedAt,
      receivedAt: proof.receivedAt,
    },
  };
}

export type OTPCodeItem = {
  index: SafeIndexHex;
  period: number;
  codes: [string, string, string];
};
export type OTPBatch = OTPTimeAnchor & {items: OTPCodeItem[]};

export function decodeOTPBatch(
  response: Awaited<ReturnType<OTPApplet['calculate']>>,
  indices: readonly Uint8Array[],
  anchor: OTPTimeAnchor,
): OTPBatch {
  if (
    response.time.length !== 8 ||
    new DataView(
      response.time.buffer,
      response.time.byteOffset,
      8,
    ).getBigUint64(0) !== anchor.time ||
    response.items.length !== indices.length
  )
    throw new MonoidCardError('Invalid OTP response');
  const items = response.items.map((item, index): OTPCodeItem => {
    const digits = item.codes[0]?.length;
    if (
      !equalBytes(item.index, indices[index]) ||
      !Number.isInteger(item.period) ||
      item.period < 1 ||
      item.period > 32767 ||
      item.codes.length !== OTP_BATCH_SIZE ||
      (digits !== 6 && digits !== 8) ||
      item.codes.some(code => code.length !== digits || !/^\d+$/.test(code))
    )
      throw new MonoidCardError('Invalid OTP response');
    return {
      index: uint8ArrayToHex(item.index),
      period: item.period,
      codes: [...item.codes] as [string, string, string],
    };
  });
  return {...anchor, items};
}

/** The caller has just authenticated Monoid with {pin, aid: OTP_AID}. */
export async function calculatePreparedOTP(
  prepared: PreparedOTP,
  monoid: MonoidApplet,
  signal: AbortSignal,
): Promise<OTPBatch> {
  signal.throwIfAborted();
  const applet = await prepared.applet.useSession(monoid);
  signal.throwIfAborted();
  const response = await applet.calculate({});
  signal.throwIfAborted();
  return decodeOTPBatch(response, prepared.indices, prepared.time);
}

/** Use monotonic elapsed time, keeping wall-clock changes out of code selection. */
export function currentOTPCode(
  batch: OTPTimeAnchor,
  item: OTPCodeItem,
  now = performance.now(),
): {code: string; remaining: number} | undefined {
  return otpCodeState(batch, item, now).current;
}

/** A continuous clock selects one window at each boundary, without hiding codes. */
export function otpCodeState(
  batch: OTPTimeAnchor,
  item: OTPCodeItem,
  now = performance.now(),
): {
  current?: {code: string; remaining: number};
  progress: number;
  prefetched: number;
  exhausted: boolean;
} {
  if (now < batch.receivedAt || batch.receivedAt < batch.requestedAt)
    return {progress: 0, prefetched: 0, exhausted: true};
  // Remote timestamps have whole-second precision and unknown network delay.
  // Use the midpoint estimate; local time retains its actual millisecond phase.
  const origin =
    batch.secondStartedAt ?? (batch.requestedAt + batch.receivedAt) / 2 - 500;
  const elapsed = Math.max(0, (now - origin) / 1000);
  const wholeSeconds = Math.floor(elapsed);
  const time = batch.time + BigInt(wholeSeconds);
  const period = BigInt(item.period);
  const window = time / period;
  const offset = window - batch.time / period;
  if (offset < BigInt(0) || offset >= BigInt(OTP_BATCH_SIZE))
    return {progress: 0, prefetched: 0, exhausted: true};
  const remaining =
    Number((window + BigInt(1)) * period - time) - (elapsed - wholeSeconds);
  return {
    current: {
      code: item.codes[Number(offset)],
      remaining: Math.ceil(remaining),
    },
    progress: remaining / item.period,
    prefetched: OTP_BATCH_SIZE - Number(offset) - 1,
    exhausted: false,
  };
}
