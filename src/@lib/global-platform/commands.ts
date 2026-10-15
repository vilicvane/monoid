import {AppletISOError} from '../applet.js';

export type CardTransceive = (command: Uint8Array) => Promise<Uint8Array>;

export function concat(...arrays: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    arrays.reduce((sum, array) => sum + array.length, 0),
  );
  let offset = 0;

  for (const array of arrays) {
    output.set(array, offset);
    offset += array.length;
  }

  return output;
}

export function shortCommand(
  ins: number,
  p1: number,
  p2: number,
  data: Uint8Array,
  cla = 0x80,
): Uint8Array {
  if (data.length > 247) {
    throw new Error('Card command exceeds the short APDU limit.');
  }

  return new Uint8Array([cla, ins, p1, p2, data.length, ...data, 0x00]);
}

export function lengthValue(value: Uint8Array): Uint8Array {
  if (value.length > 255) {
    throw new Error('Card command field exceeds the short length limit.');
  }

  return new Uint8Array([value.length, ...value]);
}

export function parseResponse(response: Uint8Array): {
  data: Uint8Array;
  sw: number;
} {
  if (response.length < 2) {
    throw new Error('The card returned an incomplete response.');
  }

  return {
    data: response.subarray(0, -2),
    sw: (response[response.length - 2] << 8) | response[response.length - 1],
  };
}

export function successful(
  response: Uint8Array,
  operation: string,
): Uint8Array {
  const {data, sw} = parseResponse(response);

  if (sw !== 0x9000) {
    throw new AppletISOError(operation, sw, data);
  }

  return data;
}

/** ISO response continuation happens below secure-channel command wrapping. */
export async function exchange(
  transceive: CardTransceive,
  command: Uint8Array,
): Promise<Uint8Array> {
  let response = await transceive(command);
  const chunks: Uint8Array[] = [];

  for (let count = 0; ; count++) {
    const {data, sw} = parseResponse(response);

    if (sw >> 8 !== 0x61) {
      return concat(...chunks, response);
    }

    if (count === 255) {
      throw new Error('The card response did not finish.');
    }

    chunks.push(data);
    response = await transceive(
      new Uint8Array([0x00, 0xc0, 0x00, 0x00, sw & 0xff]),
    );
  }
}

export function readTLV(data: Uint8Array): {tag: number; value: Uint8Array}[] {
  const fields: {tag: number; value: Uint8Array}[] = [];
  let offset = 0;

  while (offset < data.length) {
    let tag = data[offset++];

    if ((tag & 0x1f) === 0x1f) {
      if (offset >= data.length || data[offset] & 0x80) {
        throw new Error('Unsupported card response tag.');
      }

      tag = (tag << 8) | data[offset++];
    }

    if (offset >= data.length) {
      throw new Error('Missing card response length.');
    }

    let length = data[offset++];

    if (length & 0x80) {
      const count = length & 0x7f;

      if (count < 1 || count > 2 || offset + count > data.length) {
        throw new Error('Invalid card response length.');
      }

      length = 0;

      for (let i = 0; i < count; i++) {
        length = (length << 8) | data[offset++];
      }
    }

    if (offset + length > data.length) {
      throw new Error('Truncated card response.');
    }

    fields.push({tag, value: data.subarray(offset, offset + length)});
    offset += length;
  }

  return fields;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}
