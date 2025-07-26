import {decode, encode} from 'cbor2';
import * as x from 'x-value';

import type {xUint8ArrayTypeSymbol} from './atomics.js';

declare global {
  namespace XValue {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Using extends UsingXCBORMedium {}
  }
}

export type UsingXCBORMedium = {
  'x-cbor': XCBORTypes;
};

export type XCBORTypes = {
  packed: Uint8Array;
  // [x.neverTypeSymbol]: never;
  // [x.unknownTypeSymbol]: unknown;
  // [xUint8ArrayTypeSymbol]: Uint8Array;
  // [x.stringTypeSymbol]: string;
  // [x.numberTypeSymbol]: number;
  // [x.booleanTypeSymbol]: boolean;
};

export const xCBOR = x.medium<UsingXCBORMedium>({
  packing: {
    pack: data => encode(data),
    unpack: data => decode(data),
  },
});
