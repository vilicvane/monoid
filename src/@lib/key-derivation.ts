import {ed25519} from '@noble/curves/ed25519';
import {p256} from '@noble/curves/nist';

import {PublicKeyHex, type SafeIndexHex} from '../@atomics.js';
import {hexToUint8Array, uint8ArrayToHex} from '../@utils/index.js';

import type {MonoidApplet, MonoidAppletKey} from './monoid/index.js';

export type SeedKeyDerivation = {
  type: 'monoid-001';
  curve: 'ed25519' | 'secp256r1';
  context: string;
};

export type DerivedKeyPublicKeyData = {
  derivation: SeedKeyDerivation;
  publicKey: PublicKeyHex;
};

export function assertSeedKeySource(index: string): void {
  if (!/^02[0-9a-f]{18}$/.test(index))
    throw new Error('Key derivation requires a seed.');
}

export function parseSeedKeyDerivation(value: unknown): SeedKeyDerivation {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid key derivation.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 3)
    throw new Error('Invalid key derivation.');
  if (
    input.type === 'monoid-001' &&
    (input.curve === 'ed25519' || input.curve === 'secp256r1') &&
    typeof input.context === 'string'
  ) {
    // The App stores exact UTF-8 text; it never adds a purpose or normalizes text.
    const encoded = new TextEncoder().encode(input.context);
    if (
      new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(
        encoded,
      ) !== input.context
    )
      throw new Error('Context must contain valid Unicode text.');
    return {type: 'monoid-001', curve: input.curve, context: input.context};
  }
  throw new Error('Invalid key derivation.');
}

export function getSeedKeyDerivationId(value: SeedKeyDerivation): string {
  const derivation = parseSeedKeyDerivation(value);
  return JSON.stringify([
    'monoid-001',
    derivation.curve,
    uint8ArrayToHex(new TextEncoder().encode(derivation.context)),
  ]);
}

export function normalizeKeyPublicKey(
  curve: SeedKeyDerivation['curve'],
  publicKey: Uint8Array,
): PublicKeyHex {
  if (curve === 'ed25519') {
    if (publicKey.length !== 32)
      throw new Error('Expected a 32-byte ed25519 public key.');
    const point = ed25519.Point.fromHex(publicKey, false);
    point.assertValidity();
    if (point.isSmallOrder() || !point.isTorsionFree())
      throw new Error('Invalid ed25519 public key.');
    return PublicKeyHex.satisfies(uint8ArrayToHex(point.toBytes()));
  }
  if (curve !== 'secp256r1' || ![33, 65].includes(publicKey.length))
    throw new Error('Expected a secp256r1 SEC1 public key.');
  const point = p256.Point.fromHex(publicKey);
  point.assertValidity();
  return PublicKeyHex.satisfies(uint8ArrayToHex(point.toBytes(false)));
}

export function normalizeDerivedPublicKeyData(
  value: DerivedKeyPublicKeyData,
): DerivedKeyPublicKeyData {
  const derivation = parseSeedKeyDerivation(value.derivation);
  if (
    typeof value.publicKey !== 'string' ||
    !/^(?:[0-9a-f]{2})+$/.test(value.publicKey)
  )
    throw new Error('Invalid derived public key.');
  return {
    derivation,
    publicKey: normalizeKeyPublicKey(
      derivation.curve,
      hexToUint8Array(value.publicKey),
    ),
  };
}

export function mergeDerivedPublicKeys(
  ...groups: readonly (readonly DerivedKeyPublicKeyData[])[]
): DerivedKeyPublicKeyData[] {
  const values = new Map<string, DerivedKeyPublicKeyData>();
  for (const group of groups) {
    for (const input of group) {
      const value = normalizeDerivedPublicKeyData(input);
      const identity = getSeedKeyDerivationId(value.derivation);
      const previous = values.get(identity);
      if (previous && previous.publicKey !== value.publicKey)
        throw new Error('The key derivation has conflicting public keys.');
      values.set(identity, value);
    }
  }
  return [...values.values()];
}

export function getSeedDerivedAppletKey(
  index: SafeIndexHex,
  value: SeedKeyDerivation,
): MonoidAppletKey {
  assertSeedKeySource(index);
  const derivation = parseSeedKeyDerivation(value);
  const source = {type: 'seed' as const, index: hexToUint8Array(index)};
  return derivation.curve === 'ed25519'
    ? {
        ...source,
        derivation: {
          type: 'monoid-001',
          curve: 'ed25519',
          context: new TextEncoder().encode(derivation.context),
        },
      }
    : {
        ...source,
        derivation: {
          type: 'monoid-001',
          curve: 'secp256r1',
          context: new TextEncoder().encode(derivation.context),
        },
      };
}

export async function readSeedDerivedKeys(
  applet: MonoidApplet,
  sourceIndex: SafeIndexHex,
  parameters: readonly SeedKeyDerivation[],
  signal: AbortSignal,
): Promise<DerivedKeyPublicKeyData[]> {
  const keys: DerivedKeyPublicKeyData[] = [];
  for (const value of parameters) {
    signal.throwIfAborted();
    const derivation = parseSeedKeyDerivation(value);
    const {publicKey} = await applet.viewKey(
      getSeedDerivedAppletKey(sourceIndex, derivation),
    );
    signal.throwIfAborted();
    keys.push({
      derivation,
      publicKey: normalizeKeyPublicKey(derivation.curve, publicKey),
    });
  }
  return mergeDerivedPublicKeys(keys);
}
