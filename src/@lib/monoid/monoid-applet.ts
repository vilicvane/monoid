import * as x from 'x-value';

import {
  BIP39Path,
  BIP39Seed,
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
import {CBORApplet} from '../cbor-applet.js';

const SafeItemType = x.union([SafeKnownType, SafeUnknownType]);

const KeyOptions = x.union([
  x.object({
    seed: BIP39Seed.optional(),
    curve: CurveName,
    path: BIP39Path,
  }),
  x.object({}),
]);

export type MonoidAppletKeyOptions = x.TypeOf<typeof KeyOptions>;

const Key = x.intersection([
  x.object({
    index: SafeIndex,
  }),
  KeyOptions,
]);

export type MonoidAppletKey = x.TypeOf<typeof Key>;

export const MonoidAppletInvalidPINError = x.object({
  code: x.literal('INVALID_PIN'),
  tries: x.number,
});

export type MonoidApplet = ReturnType<typeof createMonoidApplet>;

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createMonoidApplet(aid: Uint8Array) {
  return CBORApplet.create(aid, {
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
        pin: x.string,
        safe: x.literal(true).optional(),
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
      request: x.object({}),
      response: x.object({
        items: x.array(
          x.object({
            index: SafeIndex,
            type: SafeItemType,
            alias: x.string.optional(),
          }),
        ),
      }),
    },

    viewKey: {
      ins: 0x40,
      request: Key,
      response: x.object({
        publicKey: PublicKey,
        chainCode: ChainCode.optional(),
      }),
    },
  });
}
