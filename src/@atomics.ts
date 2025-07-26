import * as x from 'x-value';

import {XUint8Array} from './@x-value/index.js';

export const MonoidAppletId = XUint8Array.nominal<'monoid applet id'>();
export type MonoidAppletId = x.TypeOf<typeof MonoidAppletId>;

export const SafeIndex = XUint8Array.nominal<'safe index'>();
export type SafeIndex = x.TypeOf<typeof SafeIndex>;

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

export const ChainCode = XUint8Array.nominal<'chain code'>();
export type ChainCode = x.TypeOf<typeof ChainCode>;

export const BIP39Seed = XUint8Array.nominal<'bip39 seed'>();
export type BIP39Seed = x.TypeOf<typeof BIP39Seed>;

export const BIP39Path = XUint8Array.nominal<'bip39 path'>();
export type BIP39Path = x.TypeOf<typeof BIP39Path>;
