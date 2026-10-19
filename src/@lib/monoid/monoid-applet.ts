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
const SafeItemKeyType = x.union([
  x.literal('entropy'),
  x.literal('seed'),
  x.literal('master'),
  x.literal('secp256k1'),
  x.literal('secp256r1'),
  x.literal('ed25519'),
]);

const Features = x.object({
  curves: x.array(
    x.object({
      name: CurveName,
      ciphers: x.array(CipherName),
    }),
  ),
});

const SafeInformation = x.object({
  id: MonoidSafeId,
  publicKey: PublicKey,
  pin: x.union([x.number, x.literal(false)]),
  unlocked: x.boolean,
});

export const MonoidAppletHello = x.object({
  version: x.number,
  id: MonoidId,
  features: Features,
  pin: x.union([x.number, x.literal(false)]),
  safe: SafeInformation.optional(),
});
export type MonoidAppletHello = x.TypeOf<typeof MonoidAppletHello>;

export const MonoidAppletHelloWithSafe = x.intersection([
  MonoidAppletHello,
  x.object({safe: SafeInformation}),
]);
export type MonoidAppletHelloWithSafe = x.TypeOf<
  typeof MonoidAppletHelloWithSafe
>;

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
export type MonoidAppletED25519Key = x.TypeOf<typeof KeyED25519>;

export const MonoidAppletInvalidPINError = x.object({
  code: x.literal('INVALID_PIN'),
  tries: x.number,
});

export type MonoidApplet = ReturnType<typeof createMonoidApplet>;

export const monoidCommandDefinitions = {
  hello: {
    ins: 0x20,
    request: x.object({
      safe: x.boolean.optional(),
    }),
    response: MonoidAppletHello,
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

  systemInformation: {
    ins: 0x2f,
    request: x.object({}),
    response: x.object({
      versions: x.object({
        monoid: x.number,
        javacard: x.tuple([x.number, x.number]),
      }),
      memories: x.object({
        persistent: x.object({available: x.number}),
        transient: x.object({reset: x.number, deselect: x.number}),
      }),
      features: Features,
    }),
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
          secret: x.boolean,
        }),
      ),
    }),
  },

  view: {
    ins: 0x31,
    request: x.object({index: SafeIndex}),
    response: x.object({
      key: XUint8Array.optional(),
      alias: x.string.optional(),
      secret: x.boolean,
    }),
  },

  // Secret items cannot be read as plaintext, even with Safe authentication.
  get: {
    ins: 0x32,
    request: x.object({index: SafeIndex}),
    response: x.object({data: XUint8Array}),
  },

  set: {
    ins: 0x33,
    request: x.object({
      index: SafeIndex,
      alias: x.string.optional(),
      data: XUint8Array.optional(),
      secret: x.boolean.optional(),
    }),
    response: x.object({}),
  },

  create: {
    ins: 0x34,
    request: x.intersection([
      x.object({
        data: XUint8Array,
        key: XUint8Array.optional(),
        alias: x.string.optional(),
        secret: x.boolean.optional(),
      }),
      x.union([x.object({type: SafeItemType}), x.object({index: SafeIndex})]),
    ]),
    response: x.object({index: SafeIndex}),
  },

  remove: {
    ins: 0x35,
    request: x.object({index: SafeIndex}),
    response: x.object({}),
  },

  // Requires Safe authentication; data is encrypted for recipientPublicKey.
  exportItem: {
    ins: 0x36,
    request: x.object({
      index: SafeIndex,
      recipientPublicKey: PublicKey,
    }),
    response: x.object({
      key: XUint8Array.optional(),
      alias: x.string.optional(),
      data: XUint8Array,
    }),
  },

  // Preserve the original index and metadata, including omitted versus empty fields.
  importItem: {
    ins: 0x37,
    request: x.object({
      index: SafeIndex,
      senderPublicKey: PublicKey,
      key: XUint8Array.optional(),
      alias: x.string.optional(),
      data: XUint8Array,
    }),
    response: x.object({}),
  },

  createRandomKey: {
    ins: 0x38,
    request: x.object({
      type: SafeItemKeyType,
      length: x.number.optional(),
    }),
    response: x.object({index: SafeIndex}),
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
export function createMonoidApplet(
  // Select by the version-independent prefix during normal card use.
  aid: Uint8Array = Uint8Array.from([
    0xf0, 0x6d, 0x6f, 0x6e, 0x6f, 0x69, 0x64, 0x02, 0x01,
  ]),
) {
  return CBORApplet.create(aid, monoidCommandDefinitions);
}
