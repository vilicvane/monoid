import * as x from 'x-value';

import {XUint8Array} from './@x-value/index.js';

export const MonoidId = XUint8Array.nominal<'monoid id'>();
export type MonoidId = x.TypeOf<typeof MonoidId>;

export const MonoidIdHex = x.string.nominal<'monoid id hex'>();
export type MonoidIdHex = x.TypeOf<typeof MonoidIdHex>;

export const MONOID_PIN_MIN_LENGTH = 6;
export const MONOID_PIN_MAX_LENGTH = 32;

export const MonoidPIN = x.pattern(
  new RegExp(
    `^[\\x20-\\x7E]{${MONOID_PIN_MIN_LENGTH},${MONOID_PIN_MAX_LENGTH}}$`,
  ),
);
export type MonoidPIN = x.TypeOf<typeof MonoidPIN>;

export const SafeIndex = XUint8Array.nominal<'safe index'>();
export type SafeIndex = x.TypeOf<typeof SafeIndex>;

export const SafeIndexHex = x.string.nominal<'safe index hex'>();
export type SafeIndexHex = x.TypeOf<typeof SafeIndexHex>;

export const SafeKnownType = x.string.nominal<'safe known type'>();
export type SafeKnownType = x.TypeOf<typeof SafeKnownType>;
export const SafeUnknownType = x.number.nominal<'safe unknown type'>();
export type SafeUnknownType = x.TypeOf<typeof SafeUnknownType>;

export const CurveName = x.string.nominal<'curve name'>();
export type CurveName = x.TypeOf<typeof CurveName>;

export const CipherName = x.string.nominal<'cipher name'>();
export type CipherName = x.TypeOf<typeof CipherName>;

export const PublicKey = XUint8Array.nominal<'public key'>();
export type PublicKey = x.TypeOf<typeof PublicKey>;

export const PublicKeyHex = x.string.nominal<'public key hex'>();
export type PublicKeyHex = x.TypeOf<typeof PublicKeyHex>;

export const ChainCode = XUint8Array.nominal<'chain code'>();
export type ChainCode = x.TypeOf<typeof ChainCode>;

export const ChainCodeHex = x.string.nominal<'chain code hex'>();
export type ChainCodeHex = x.TypeOf<typeof ChainCodeHex>;

export const BIP39Seed = x.string.nominal<'bip39 seed'>();
export type BIP39Seed = x.TypeOf<typeof BIP39Seed>;

export const BIP39Path = XUint8Array.nominal<'bip39 path'>();
export type BIP39Path = x.TypeOf<typeof BIP39Path>;

export const BIP39PathString = x.string.refined<'bip39 path string', unknown>(
  value =>
    x.refinement(
      /^m(?:\/(?:[1-9]\d*|0)'?)+$/.test(value),
      value,
      'Invalid BIP39 path.',
    ),
);
export type BIP39PathString = x.TypeOf<typeof BIP39PathString>;

export const EthereumAddress = x.string.nominal<'ethereum address'>();
export type EthereumAddress = x.TypeOf<typeof EthereumAddress>;
