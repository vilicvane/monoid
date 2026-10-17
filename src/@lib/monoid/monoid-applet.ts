import * as x from 'x-value';

import {
  BIP39Path,
  ChainCode,
  CipherName,
  CurveName,
  MonoidId,
  MonoidPIN,
  MonoidSafeId,
  PublicKey,
  SafeIndex,
  SafeKnownType,
  SafeUnknownType,
} from '../../@atomics.js';
import {XUint8Array} from '../../@x-value/index.js';
import type {CBORCommandDefinitions} from '../cbor-applet.js';
import {CBORApplet} from '../cbor-applet.js';

const SafeItemType = x.union([SafeKnownType, SafeUnknownType]);

const KeyIndex = x.object({index: SafeIndex});
const DerivableKeyType = x.union([x.literal('seed'), x.literal('master')]);

const KeySECP256K1 = x.intersection([
  KeyIndex,
  x.union([
    x.object({type: x.literal('secp256k1')}),
    x.object({
      type: DerivableKeyType,
      derivation: x.object({
        type: x.literal('bip32'),
        path: BIP39Path,
      }),
    }),
  ]),
]);

const KeyED25519 = x.intersection([
  KeyIndex,
  x.union([
    x.object({type: x.literal('ed25519')}),
    x.object({
      type: DerivableKeyType,
      derivation: x.object({
        type: x.literal('slip10'),
        curve: x.literal('ed25519'),
        path: BIP39Path,
      }),
    }),
  ]),
]);

const KeySECP256R1 = x.intersection([
  KeyIndex,
  x.union([
    x.object({type: x.literal('secp256r1')}),
    x.object({
      type: DerivableKeyType,
      derivation: x.object({
        type: x.literal('monoid-001'),
        context: XUint8Array,
      }),
    }),
  ]),
]);

const Key = x.union([KeySECP256K1, KeySECP256R1, KeyED25519]);
const Taproot = x.union([
  x.boolean,
  x.object({merkleRoot: XUint8Array.optional()}),
]);
const TaprootOptions = x.object({
  taproot: Taproot.optional(),
});

const ViewKey = x.union([
  x.intersection([KeySECP256K1, TaprootOptions]),
  KeySECP256R1,
  KeyED25519,
]);

export type MonoidAppletKey = x.TypeOf<typeof Key>;
export type MonoidAppletSECP256K1Key = x.TypeOf<typeof KeySECP256K1>;

export const MonoidAppletInvalidPINError = x.object({
  code: x.literal('INVALID_PIN'),
  tries: x.number,
});

export type MonoidApplet = ReturnType<typeof createMonoidApplet>;

export const monoidCommandDefinitions = {
  hello: {
    ins: 0x20,
    request: x.object({}),
    response: x.object({
      version: x.number,
      id: MonoidId,
      features: x.object({
        curves: x.array(
          x.object({
            name: CurveName,
            ciphers: x.array(CipherName),
          }),
        ),
      }),
      pin: x.union([x.number, x.literal(false)]),
      safe: x.object({
        id: MonoidSafeId,
        pin: x.union([x.number, x.literal(false)]),
        unlocked: x.boolean,
      }),
    }),
  },

  authenticate: {
    ins: 0x21,
    request: x.object({
      safe: x.literal(true).optional(),
      pin: x.string,
    }),
    response: x.object({}),
  },

  setPIN: {
    ins: 0x22,
    request: x.object({
      pin: MonoidPIN,
      safe: x.literal(true).optional(),
    }),
    response: x.object({}),
  },

  list: {
    ins: 0x30,
    request: x.object({
      type: SafeItemType.optional(),
      keyPrefix: XUint8Array.optional(),
    }),
    response: x.object({
      items: x.array(
        x.object({
          index: SafeIndex,
          type: SafeItemType.optional(),
          key: XUint8Array.optional(),
          alias: x.string.optional(),
        }),
      ),
    }),
  },

  set: {
    ins: 0x33,
    request: x.object({
      index: SafeIndex,
      alias: x.string.optional(),
      data: XUint8Array.optional(),
    }),
    response: x.object({}),
  },

  viewKey: {
    ins: 0x40,
    request: ViewKey,
    response: x.object({
      publicKey: PublicKey,
      chainCode: ChainCode.optional(),
    }),
  },

  sign: {
    ins: 0x41,
    request: x.union([
      x.intersection([
        x.union([KeySECP256K1, KeySECP256R1]),
        x.object({
          cipher: x.literal('ecdsa'),
          digest: XUint8Array,
        }),
      ]),
      x.intersection([
        KeyED25519,
        x.object({
          cipher: x.literal('ed25519'),
          message: XUint8Array,
        }),
      ]),
      x.intersection([
        KeySECP256K1,
        x.object({
          cipher: x.literal('bip340'),
          taproot: Taproot.optional(),
          digest: XUint8Array,
        }),
      ]),
    ]),
    response: x.object({
      signature: XUint8Array,
    }),
  },
} satisfies CBORCommandDefinitions;

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createMonoidApplet(aid: Uint8Array) {
  return CBORApplet.create(aid, monoidCommandDefinitions);
}
