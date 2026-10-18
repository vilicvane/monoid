import CryptoJS from 'crypto-js';

export type GlobalPlatformTransceive = (
  command: Uint8Array,
) => Promise<Uint8Array>;

export const SCP03_S8_VARIANTS: readonly number[] = [
  0x00, 0x10, 0x20, 0x30, 0x60, 0x70,
];

export class GlobalPlatformSecureChannelError extends Error {
  constructor(
    readonly code:
      | 'GP_AUTHENTICATION_FAILED'
      | 'GP_UNSUPPORTED_PROTOCOL'
      | 'GP_INVALID_RESPONSE'
      | 'GP_CHANNEL_CLOSED'
      | 'GP_CHANNEL_BUSY',
    message: string,
    readonly statusWord?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

const factoryKey = Uint8Array.from({length: 16}, (_, index) => 0x40 + index);

function concat(...arrays: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    arrays.reduce((length, array) => length + array.length, 0),
  );
  let offset = 0;

  for (const array of arrays) {
    output.set(array, offset);
    offset += array.length;
  }

  return output;
}

function words(bytes: Uint8Array): CryptoJS.lib.WordArray {
  const value = new Array<number>(Math.ceil(bytes.length / 4)).fill(0);

  for (let index = 0; index < bytes.length; index++) {
    value[index >>> 2] |= bytes[index] << (24 - (index % 4) * 8);
  }

  return CryptoJS.lib.WordArray.create(value, bytes.length);
}

function bytes(value: CryptoJS.lib.WordArray): Uint8Array {
  return Uint8Array.from(
    {length: value.sigBytes},
    (_, index) => (value.words[index >>> 2] >>> (24 - (index % 4) * 8)) & 0xff,
  );
}

function encrypt(
  cipher: typeof CryptoJS.AES,
  key: Uint8Array,
  data: Uint8Array,
  iv?: Uint8Array,
): Uint8Array {
  return bytes(
    cipher.encrypt(words(data), words(key), {
      mode: iv ? CryptoJS.mode.CBC : CryptoJS.mode.ECB,
      iv: iv && words(iv),
      padding: CryptoJS.pad.NoPadding,
    }).ciphertext,
  );
}

function pad80(data: Uint8Array, blockSize: number): Uint8Array {
  const padded = new Uint8Array(
    (Math.floor(data.length / blockSize) + 1) * blockSize,
  );
  padded.set(data);
  padded[data.length] = 0x80;

  return padded;
}

function xor(left: Uint8Array, right: Uint8Array): Uint8Array {
  return left.map((value, index) => value ^ right[index]);
}

function doubleBlock(block: Uint8Array): Uint8Array {
  const doubled = block.map(
    (value, index) => ((value << 1) | ((block[index + 1] ?? 0) >>> 7)) & 0xff,
  );
  doubled[15] ^= block[0] & 0x80 ? 0x87 : 0;

  return doubled;
}

/** AES-CMAC, RFC 4493 section 2.4; AES itself is supplied by CryptoJS. */
function aesCmac(key: Uint8Array, data: Uint8Array): Uint8Array {
  const firstSubkey = doubleBlock(
    encrypt(CryptoJS.AES, key, new Uint8Array(16)),
  );
  const complete = data.length > 0 && data.length % 16 === 0;
  const padded = complete ? data : pad80(data, 16);
  const lastOffset = padded.length - 16;
  let state: Uint8Array = new Uint8Array(16);

  for (let offset = 0; offset < lastOffset; offset += 16) {
    state = encrypt(
      CryptoJS.AES,
      key,
      xor(state, padded.subarray(offset, offset + 16)),
    );
  }

  const last = xor(
    padded.subarray(lastOffset),
    complete ? firstSubkey : doubleBlock(firstSubkey),
  );

  return encrypt(CryptoJS.AES, key, xor(state, last));
}

/** SCP03 Amendment D, section 6.2.1: one counter block for 64/128 bits. */
function scp03Kdf(
  key: Uint8Array,
  constant: number,
  context: Uint8Array,
  length: 8 | 16,
): Uint8Array {
  const label = new Uint8Array(16);
  label[11] = constant;
  label[14] = length * 8;
  label[15] = 1;

  return aesCmac(key, concat(label, context)).slice(0, length);
}

function scp02Key(constant: number, sequence: Uint8Array): Uint8Array {
  const input = new Uint8Array(16);
  input[0] = 1;
  input[1] = constant;
  input.set(sequence, 2);

  return encrypt(CryptoJS.TripleDES, factoryKey, input, new Uint8Array(8));
}

function scp02Cryptogram(key: Uint8Array, input: Uint8Array): Uint8Array {
  return encrypt(
    CryptoJS.TripleDES,
    key,
    pad80(input, 8),
    new Uint8Array(8),
  ).slice(-8);
}

function scp02Mac(
  key: Uint8Array,
  input: Uint8Array,
  iv: Uint8Array,
): Uint8Array {
  const padded = pad80(input, 8);

  if (padded.length > 8) {
    iv = encrypt(
      CryptoJS.DES,
      key.subarray(0, 8),
      padded.subarray(0, -8),
      iv,
    ).slice(-8);
  }

  return encrypt(CryptoJS.TripleDES, key, padded.subarray(-8), iv);
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;

  for (let index = 0; index < left.length; index++) {
    difference |= left[index] ^ right[index];
  }

  return difference === 0;
}

function successfulResponse(
  response: Uint8Array,
  operation: string,
): Uint8Array {
  if (response.length < 2) {
    throw new GlobalPlatformSecureChannelError(
      'GP_INVALID_RESPONSE',
      'The card returned an incomplete response.',
    );
  }

  const sw =
    (response[response.length - 2] << 8) | response[response.length - 1];

  if (sw !== 0x9000) {
    throw new GlobalPlatformSecureChannelError(
      'GP_AUTHENTICATION_FAILED',
      `${operation} failed (${sw.toString(16).toUpperCase()}).`,
      sw,
    );
  }

  return response.subarray(0, -2);
}

function commandForMac(command: Uint8Array): {
  input: Uint8Array;
  le: Uint8Array;
} {
  const length = command.length > 5 ? command[4] : 0;

  if (
    command.length < 4 ||
    length > 247 ||
    (command.length > 5 &&
      (length === 0 ||
        (command.length !== 5 + length && command.length !== 6 + length)))
  ) {
    throw new RangeError(
      'Secure messaging requires a short APDU with at most 247 data bytes.',
    );
  }

  const input = new Uint8Array(5 + length);
  input.set(command.subarray(0, 4));
  input[0] |= 0x04;
  input[4] = length + 8;
  input.set(command.subarray(5, 5 + length), 5);

  return {
    input,
    le:
      command.length === 5 || command.length === 6 + length
        ? command.slice(-1)
        : new Uint8Array(),
  };
}

/**
 * Initial installation with the public factory key, no diversification.
 * Supports the current cards' SCP02 i=55 profile and SCP03 S8, at C-MAC level 01.
 * SCP02 does not report i in INITIALIZE UPDATE; i=55 is a profile assumption.
 * Protocol reference: GPPro f2af9ef GPSession, SCP02Wrapper and SCP03Wrapper;
 * https://github.com/martinpaljak/GlobalPlatformPro/tree/f2af9ef/library/src/main/java/pro/javacard/gp
 */
export async function openSecureChannel(
  transceive: GlobalPlatformTransceive,
): Promise<{
  protocol: 2 | 3;
  transceive: GlobalPlatformTransceive;
}> {
  const hostChallenge = crypto.getRandomValues(new Uint8Array(8));
  const update = successfulResponse(
    await transceive(Uint8Array.of(0x80, 0x50, 0, 0, 8, ...hostChallenge, 0)),
    'INITIALIZE UPDATE',
  );

  if (update.length < 12) {
    throw new GlobalPlatformSecureChannelError(
      'GP_INVALID_RESPONSE',
      'The card returned an invalid INITIALIZE UPDATE response.',
    );
  }

  const protocol = update[11];

  if (protocol !== 2 && protocol !== 3) {
    throw new GlobalPlatformSecureChannelError(
      'GP_UNSUPPORTED_PROTOCOL',
      'This card does not support the available installation secure channels.',
    );
  }

  const variant = protocol === 3 ? update[12] : 0x55;

  if (protocol === 3 && !SCP03_S8_VARIANTS.includes(variant)) {
    throw new GlobalPlatformSecureChannelError(
      'GP_UNSUPPORTED_PROTOCOL',
      'This SCP03 mode is not supported for installation.',
    );
  }

  const expectedLength = protocol === 2 ? 28 : variant & 0x10 ? 32 : 29;

  if (update.length !== expectedLength) {
    throw new GlobalPlatformSecureChannelError(
      'GP_INVALID_RESPONSE',
      'The card returned an invalid INITIALIZE UPDATE response.',
    );
  }

  const offset = protocol === 2 ? 12 : 13;
  const cardChallenge = update.subarray(offset, offset + 8);
  const context = concat(hostChallenge, cardChallenge);
  const macKey =
    protocol === 2
      ? scp02Key(0x01, cardChallenge.subarray(0, 2))
      : scp03Kdf(factoryKey, 0x06, context, 16);
  const encKey =
    protocol === 2 ? scp02Key(0x82, cardChallenge.subarray(0, 2)) : undefined;
  const expectedCryptogram = encKey
    ? scp02Cryptogram(encKey, context)
    : scp03Kdf(macKey, 0x00, context, 8);

  if (!equal(expectedCryptogram, update.subarray(offset + 8, offset + 16))) {
    throw new GlobalPlatformSecureChannelError(
      'GP_AUTHENTICATION_FAILED',
      'This card does not use the supported factory management keys.',
    );
  }

  const hostCryptogram = encKey
    ? scp02Cryptogram(encKey, concat(cardChallenge, hostChallenge))
    : scp03Kdf(macKey, 0x01, context, 8);
  let chainingValue: Uint8Array = new Uint8Array(protocol === 2 ? 8 : 16);
  let firstCommand = true;
  let busy = false;
  let usable = true;

  const send: GlobalPlatformTransceive = async command => {
    if (!usable || busy) {
      throw new GlobalPlatformSecureChannelError(
        busy ? 'GP_CHANNEL_BUSY' : 'GP_CHANNEL_CLOSED',
        busy
          ? 'Wait for the current card command to finish.'
          : 'This secure channel has ended. Scan the card again.',
      );
    }

    const {input, le} = commandForMac(command);

    if (protocol === 2) {
      const iv = firstCommand
        ? chainingValue
        : encrypt(CryptoJS.DES, macKey.subarray(0, 8), chainingValue);
      chainingValue = scp02Mac(macKey, input, iv);
    } else {
      chainingValue = aesCmac(macKey, concat(chainingValue, input));
    }

    firstCommand = false;
    busy = true;

    try {
      const response = await transceive(
        concat(input, chainingValue.subarray(0, 8), le),
      );

      if (response.length < 2) {
        throw new GlobalPlatformSecureChannelError(
          'GP_INVALID_RESPONSE',
          'The card returned an incomplete response.',
        );
      }

      return response;
    } catch (error) {
      usable = false;
      throw error;
    } finally {
      busy = false;
    }
  };

  successfulResponse(
    await send(Uint8Array.of(0x84, 0x82, 0x01, 0, 8, ...hostCryptogram)),
    'EXTERNAL AUTHENTICATE',
  );

  return {protocol, transceive: send};
}
