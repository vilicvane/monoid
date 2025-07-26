import * as x from 'x-value';

import {CBORApplet} from './cbor-applet.js';

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createMonoidApplet(aid: Uint8Array) {
  return CBORApplet.create(aid, {
    hello: {
      ins: 0x20,
      request: x.object({}),
      response: x.object({
        version: x.number,
        features: x.object({
          curves: x.array(x.string),
          ciphers: x.array(x.string),
        }),
        pin: x.union([x.number, x.literal(false)]),
        safe: x.object({
          pin: x.union([x.number, x.literal(false)]),
          unlocked: x.boolean,
        }),
      }),
    },
  });
}
