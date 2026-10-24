import * as x from 'x-value';

import {SafeIndex} from '../@atomics.js';
import {hexToUint8Array} from '../@utils/index.js';
import {XUint8Array} from '../@x-value/index.js';

import {CBORApplet, type CBORCommandDefinitions} from './cbor-applet.js';

export const OTP_AID = hexToUint8Array('f06d6f6e6f69640501');

export const otpCommandDefinitions = {
  hello: {
    ins: 0x20,
    request: x.object({}),
    response: x.object({version: XUint8Array, batchSize: x.literal(3)}),
  },
  challenge: {
    ins: 0x21,
    request: x.object({}),
    response: x.object({challenge: XUint8Array}),
  },
  prepare: {
    ins: 0x22,
    request: x.union([
      x.object({
        time: XUint8Array,
        indices: x.array(SafeIndex),
      }),
      x.object({
        data: XUint8Array,
        signature: XUint8Array,
        indices: x.array(SafeIndex),
      }),
    ]),
    response: x.object({}),
  },
  calculate: {
    ins: 0x23,
    request: x.object({}),
    response: x.object({
      time: XUint8Array,
      items: x.array(
        x.object({
          index: SafeIndex,
          period: x.number,
          codes: x.array(x.string),
        }),
      ),
    }),
  },
} satisfies CBORCommandDefinitions;

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createOTPApplet() {
  return CBORApplet.create(OTP_AID, otpCommandDefinitions);
}

export type OTPApplet = ReturnType<typeof createOTPApplet>;
