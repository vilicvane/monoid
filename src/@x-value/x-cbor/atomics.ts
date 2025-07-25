import * as x from 'x-value';

export const xUint8ArrayTypeSymbol = Symbol();

export const XUint8Array = x.atomic(xUint8ArrayTypeSymbol, value =>
  x.constraint(
    value instanceof Uint8Array,
    () => `Expected Uint8Array, got ${typeof value}.`,
  ),
);

export type XUint8Array = x.MediumTypeOf<'x-cbor', typeof XUint8Array>;
