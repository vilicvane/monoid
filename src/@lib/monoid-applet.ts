import * as x from 'x-value';

import {
  BIP39Path,
  BIP39Seed,
  ChainCode,
  CipherName,
  CurveName,
  MonoidAppletId,
  PublicKey,
  SafeIndex,
  SafeKnownType,
  SafeUnknownType,
} from '../@atomics.js';

import {CBORApplet} from './cbor-applet.js';

const Auth = x.object({
  pin: x.string,
});

export type MonoidAppletAuth = x.TypeOf<typeof Auth>;

const SafeAuth = Auth.extend({
  safe: x.literal(true),
});

const SafeItemType = x.union([SafeKnownType, SafeUnknownType]);

const Key = x.intersection([
  x.object({
    index: SafeIndex,
  }),
  x.union([
    x.object({
      seed: BIP39Seed.optional(),
      curve: CurveName,
      path: BIP39Path,
    }),
    x.object({}),
  ]),
]);

export type MonoidAppletKey = x.TypeOf<typeof Key>;

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createMonoidApplet(aid: Uint8Array) {
  return CBORApplet.create(aid, {
    hello: {
      ins: 0x20,
      request: x.object({}),
      response: x.object({
        id: MonoidAppletId,
        version: x.number,
        features: x.object({
          curves: x.array(CurveName),
          ciphers: x.array(CipherName),
        }),
        pin: x.union([x.number, x.literal(false)]),
        safe: x.object({
          pin: x.union([x.number, x.literal(false)]),
          unlocked: x.boolean,
        }),
      }),
    },

    list: {
      ins: 0x30,
      request: x.object({
        auth: Auth,
      }),
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
      request: x.intersection([
        x.object({
          auth: Auth,
        }),
        Key,
      ]),
      response: x.object({
        publicKey: PublicKey,
        chainCode: ChainCode.optional(),
      }),
    },
  });
}
