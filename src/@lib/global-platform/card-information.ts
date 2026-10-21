import {IsoDepNfc} from 'capacitor-isodep-nfc';

import {hexToUint8Array, uint8ArrayToHex} from '../../@utils/index.js';

import {
  type CardTransceive,
  exchange,
  parseResponse,
  readTLV,
  shortCommand,
  successful,
} from './commands.js';
import {CardManagerNotFoundError} from './install.js';

export type CardInformation = {
  cardManagerAid: string;
  globalPlatformVersion?: string;
  javaCardVersion?: string;
  secureChannels: string[];
  capabilities?: CardCapabilities;
  keyInformation?: CardKeyInformation[];
  cplc?: {
    icFabricator: string;
    icType: string;
    operatingSystemId: string;
    operatingSystemReleaseDate: string;
    operatingSystemReleaseLevel: string;
    icSerialNumber: string;
  };
};

export type CardCapabilities = {
  secureChannels: {protocol: string; options: string[]; keys: string[]}[];
  domainPrivileges?: string[];
  applicationPrivileges?: string[];
  loadFileHashes?: string[];
  loadFileCiphers?: string[];
  tokenVerificationCiphers?: string[];
  receiptGenerationCiphers?: string[];
  dapVerificationCiphers?: string[];
  eccKeyParameters?: string[];
};

export type CardKeyInformation = {
  id: number;
  version: number;
  components: {
    type: string;
    length?: number;
    lengthIsMinimum?: boolean;
    parameterReference?: number;
  }[];
};

/** Reads management metadata without authenticating or changing card content. */
export async function readCardInformation(
  sessionId: string,
  signal?: AbortSignal,
): Promise<CardInformation> {
  const transceive: CardTransceive = command =>
    exchange(async data => {
      signal?.throwIfAborted();

      const response = await IsoDepNfc.transceive({
        sessionId,
        data: Array.from(data),
        timeoutMs: 30000,
      });

      signal?.throwIfAborted();

      return new Uint8Array(response.data);
    }, command);
  const cardManagerAid = await selectCardManager(transceive);
  const information: CardInformation = {cardManagerAid, secureChannels: []};
  const cplc = await readOptionalData(transceive, 0x9f7f);

  if (cplc !== undefined) {
    information.cplc = parseCPLC(cplc);
  }

  const cardData = await readOptionalData(transceive, 0x0066);

  if (cardData !== undefined) {
    Object.assign(information, parseCardRecognitionData(cardData));
  }

  const capabilities = await readOptionalData(transceive, 0x0067);

  if (capabilities !== undefined) {
    information.capabilities = parseCardCapabilities(capabilities);
  }

  const keyInformation = await readOptionalData(transceive, 0x00e0);

  if (keyInformation !== undefined) {
    information.keyInformation = parseKeyInformation(keyInformation);
  }

  return information;
}

async function selectCardManager(transceive: CardTransceive): Promise<string> {
  for (const aid of ['a000000151000000', 'a000000003000000']) {
    const response = await transceive(
      shortCommand(0xa4, 0x04, 0x00, hexToUint8Array(aid), 0x00),
    );

    if (parseResponse(response).sw === 0x6a82) {
      continue;
    }

    successful(response, 'Selecting the card manager');
    return aid;
  }

  throw new CardManagerNotFoundError();
}

async function readOptionalData(
  transceive: CardTransceive,
  tag: number,
): Promise<Uint8Array | undefined> {
  // GET DATA with no command data is a five-byte case-2 APDU.
  const response = await transceive(
    new Uint8Array([0x80, 0xca, tag >> 8, tag & 0xff, 0x00]),
  );
  const {sw} = parseResponse(response);

  // Optional metadata may be unsupported or require authentication. Reading it
  // must not try management credentials merely to populate the information page.
  if ([0x6982, 0x6a81, 0x6a82, 0x6a88, 0x6d00, 0x6e00].includes(sw)) {
    return undefined;
  }

  return successful(response, 'Reading card information');
}

function parseCPLC(data: Uint8Array): NonNullable<CardInformation['cplc']> {
  // Some cards return the historical 42-byte value without its 9F7F wrapper.
  const value = data.length === 42 ? data : readSingleField(data, 0x9f7f);

  if (value.length !== 42) {
    throw new Error('Invalid card production information');
  }

  return {
    icFabricator: uint8ArrayToHex(value.subarray(0, 2)),
    icType: uint8ArrayToHex(value.subarray(2, 4)),
    operatingSystemId: uint8ArrayToHex(value.subarray(4, 6)),
    operatingSystemReleaseDate: uint8ArrayToHex(value.subarray(6, 8)),
    operatingSystemReleaseLevel: uint8ArrayToHex(value.subarray(8, 10)),
    icSerialNumber: uint8ArrayToHex(value.subarray(12, 16)),
  };
}

function parseCardRecognitionData(
  data: Uint8Array,
): Pick<
  CardInformation,
  'globalPlatformVersion' | 'javaCardVersion' | 'secureChannels'
> {
  const cardData = readSingleField(data, 0x66);
  const recognition = readTLV(cardData).filter(field => field.tag === 0x73);

  if (recognition.length !== 1) {
    throw new Error('Invalid card recognition information');
  }

  let globalPlatformVersion: string | undefined;
  let javaCardVersion: string | undefined;
  const secureChannels = new Set<string>();

  for (const field of readTLV(recognition[0].value)) {
    if (field.tag !== 0x60 && field.tag !== 0x64 && field.tag !== 0x66) {
      continue;
    }

    const identifiers = readTLV(field.value);

    if (
      !identifiers.length ||
      (field.tag !== 0x66 &&
        identifiers.some(identifier => identifier.tag !== 0x06)) ||
      (field.tag === 0x60 && identifiers.length !== 1)
    ) {
      throw new Error('Invalid card recognition identifier');
    }

    for (const identifier of identifiers) {
      if (identifier.tag !== 0x06) {
        continue;
      }

      const oid = parseObjectIdentifier(identifier.value);
      const versionPrefix = '1.2.840.114283.2.';
      const channelPrefix = '1.2.840.114283.4.';

      if (field.tag === 0x60 && oid.startsWith(versionPrefix)) {
        const version = oid.slice(versionPrefix.length);

        if (globalPlatformVersion && globalPlatformVersion !== version) {
          throw new Error('Conflicting card management versions');
        }

        globalPlatformVersion = version;
      } else if (field.tag === 0x64 && oid.startsWith(channelPrefix)) {
        const values = oid.slice(channelPrefix.length).split('.').map(Number);

        if (values.length !== 2 || values.some(value => value > 255)) {
          throw new Error('Invalid card secure channel identifier');
        }

        const protocol = values[0].toString(16).padStart(2, '0').toUpperCase();
        const option = values[1].toString(16).padStart(2, '0');

        secureChannels.add(`SCP${protocol} i=${option}`);
      } else if (field.tag === 0x66) {
        // GPPro recognizes this Sun/Oracle OID as the Java Card major version.
        // It provides no minor or patch-level compatibility guarantee.
        const match = /^1\.3\.6\.1\.4\.1\.42\.2\.110\.1\.(\d)$/.exec(oid);

        if (match) {
          if (javaCardVersion && javaCardVersion !== match[1]) {
            throw new Error('Conflicting Java Card versions');
          }

          javaCardVersion = match[1];
        }
      }
    }
  }

  return {
    globalPlatformVersion,
    javaCardVersion,
    secureChannels: [...secureChannels],
  };
}

function parseCardCapabilities(data: Uint8Array): CardCapabilities {
  const fields = readTLV(readSingleField(data, 0x67));
  const capabilities: CardCapabilities = {secureChannels: []};

  for (const {tag, value} of fields) {
    if (tag === 0xa0) {
      const channel = readTLV(value);
      const protocol = channel.find(field => field.tag === 0x80)?.value;
      const options = channel.find(field => field.tag === 0x81)?.value;
      const keys = channel.find(field => field.tag === 0x82)?.value;

      if (protocol?.length !== 1 || !options?.length) {
        throw new Error('Invalid card secure channel capabilities');
      }

      capabilities.secureChannels.push({
        protocol: `SCP${hexByte(protocol[0]).toUpperCase()}`,
        options: Array.from(options, hexByte),
        keys: keys ? readFlags(keys, AES_KEY_FLAGS) : [],
      });
    } else if (tag === 0x81 || tag === 0x82) {
      if (value.length !== 3) {
        throw new Error('Invalid card privilege capabilities');
      }

      capabilities[
        tag === 0x81 ? 'domainPrivileges' : 'applicationPrivileges'
      ] = readFlags(value, PRIVILEGE_FLAGS);
    } else if (tag === 0x83) {
      if (!value.length) {
        throw new Error('Invalid card load file hash capabilities');
      }

      capabilities.loadFileHashes = Array.from(
        value,
        algorithm => LOAD_FILE_HASHES[algorithm] ?? `0x${hexByte(algorithm)}`,
      );
    } else if (tag === 0x84) {
      capabilities.loadFileCiphers = readFlags(value, LOAD_FILE_CIPHER_FLAGS);
    } else if (tag === 0x85 || tag === 0x86 || tag === 0x87) {
      const field =
        tag === 0x85
          ? 'tokenVerificationCiphers'
          : tag === 0x86
            ? 'receiptGenerationCiphers'
            : 'dapVerificationCiphers';

      capabilities[field] = readFlags(value, SIGNATURE_FLAGS);
    } else if (tag === 0x88) {
      capabilities.eccKeyParameters = parseECCKeyParameters(value);
    }
  }

  return capabilities;
}

function parseECCKeyParameters(data: Uint8Array): string[] {
  const parameters: string[] = [];

  // GP 2.3 H.4 / B.4.2: the first byte's high bit marks a two-byte reference.
  for (let offset = 0; offset < data.length; ) {
    const length = data[offset] & 0x80 ? 2 : 1;

    if (offset + length > data.length) {
      throw new Error('Incomplete card ECC key parameter reference');
    }

    const reference = uint8ArrayToHex(data.subarray(offset, offset + length));
    const curve = length === 1 ? ECC_KEY_PARAMETERS[data[offset]] : undefined;

    parameters.push(curve ? `${curve} (0x${reference})` : `0x${reference}`);
    offset += length;
  }

  return parameters;
}

function parseKeyInformation(data: Uint8Array): CardKeyInformation[] {
  const keys: CardKeyInformation[] = [];

  for (const {tag, value} of readTLV(readSingleField(data, 0xe0))) {
    if (tag !== 0xc0) {
      continue;
    }

    // A newly created domain may have no keys in its template yet.
    if (!value.length) {
      continue;
    }

    if (value.length < 4) {
      throw new Error('Incomplete card key information');
    }

    const key: CardKeyInformation = {
      id: value[0],
      version: value[1],
      components: [],
    };
    const extended = value[2] === 0xff;
    let offset = 2;

    while (offset < value.length && (!extended || value[offset] === 0xff)) {
      if (offset + (extended ? 4 : 2) > value.length) {
        throw new Error('Incomplete card key component');
      }

      if (extended) offset++;

      const type = value[offset++];
      const length = extended
        ? (value[offset++] << 8) | value[offset++]
        : value[offset++];

      if (
        type === 0xff ||
        (extended && type !== 0xf0 && (!length || length > 0x7fff))
      ) {
        throw new Error('Invalid card key component');
      }

      const component: CardKeyInformation['components'][number] = {
        type: KEY_TYPES[type] ?? `0x${hexByte(type)}`,
      };

      if (type === 0xf0) {
        component.parameterReference = length;
      } else {
        component.length = length || 256;

        if (!extended && !length) {
          component.lengthIsMinimum = true;
        }
      }

      key.components.push(component);
    }

    if (extended) {
      // Extended templates end with optional one-byte usage and access values.
      for (let field = 0; field < 2; field++) {
        const length = value[offset++];

        if (
          length === undefined ||
          length > 1 ||
          offset + length > value.length
        ) {
          throw new Error('Invalid card key attributes');
        }

        offset += length;
      }
    }

    if (offset !== value.length) {
      throw new Error('Unexpected card key information');
    }

    keys.push(key);
  }

  return keys;
}

type Flag = readonly [byte: number, mask: number, label: string];

function readFlags(data: Uint8Array, flags: readonly Flag[]): string[] {
  if (!data.length) {
    throw new Error('Empty card capability flags');
  }

  const known = new Uint8Array(data.length);
  const values: string[] = [];

  for (const [index, mask, label] of flags) {
    if ((data[index] & mask) === mask) {
      values.push(label);
      known[index] |= mask;
    }
  }

  for (let index = 0; index < data.length; index++) {
    const unknown = data[index] & ~known[index];

    if (unknown) {
      values.push(`Unknown (byte ${index + 1}: 0x${hexByte(unknown)})`);
    }
  }

  return values;
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, '0');
}

// GP Card Specification 2.3.1, Tables 11-7/8/9 and H-7/8/9/10.
const PRIVILEGE_FLAGS: readonly Flag[] = [
  [0, 0x80, 'SecurityDomain'],
  [0, 0xc0, 'DAPVerification'],
  [0, 0xa0, 'DelegatedManagement'],
  [0, 0x10, 'CardLock'],
  [0, 0x08, 'CardTerminate'],
  [0, 0x04, 'CardReset'],
  [0, 0x02, 'CVMManagement'],
  [0, 0xc1, 'MandatedDAPVerification'],
  [1, 0x80, 'TrustedPath'],
  [1, 0x40, 'AuthorizedManagement'],
  [1, 0x20, 'TokenVerification'],
  [1, 0x10, 'GlobalDelete'],
  [1, 0x08, 'GlobalLock'],
  [1, 0x04, 'GlobalRegistry'],
  [1, 0x02, 'FinalApplication'],
  [1, 0x01, 'GlobalService'],
  [2, 0x80, 'ReceiptGeneration'],
  [2, 0x40, 'CipheredLoadFileDataBlock'],
  [2, 0x20, 'ContactlessActivation'],
  [2, 0x10, 'ContactlessSelfActivation'],
  [2, 0x08, 'PrivacyTrusted'],
];
const AES_KEY_FLAGS: readonly Flag[] = [
  [0, 0x01, 'AES-128'],
  [0, 0x02, 'AES-192'],
  [0, 0x04, 'AES-256'],
];
const LOAD_FILE_CIPHER_FLAGS: readonly Flag[] = [
  [0, 0x01, '3DES (16 bytes)'],
  [0, 0x02, 'AES-128'],
  [0, 0x04, 'AES-192'],
  [0, 0x08, 'AES-256'],
  [0, 0x80, 'ICV'],
];
const SIGNATURE_FLAGS: readonly Flag[] = [
  [0, 0x01, 'RSA1024_SHA1'],
  [0, 0x02, 'RSAPSS_SHA256'],
  [0, 0x04, 'DES_MAC'],
  [0, 0x08, 'CMAC_AES128'],
  [0, 0x10, 'CMAC_AES192'],
  [0, 0x20, 'CMAC_AES256'],
  [0, 0x40, 'ECCP256_SHA256'],
  [0, 0x80, 'ECCP384_SHA384'],
  [1, 0x01, 'ECCP512_SHA512'],
  [1, 0x02, 'ECCP521_SHA512'],
];
const LOAD_FILE_HASHES: Record<number, string | undefined> = {
  1: 'SHA-1',
  2: 'SHA-256',
  3: 'SHA-384',
  4: 'SHA-512',
};
// GP Card Specification 2.3, Table B-2: global preloaded curve references.
const ECC_KEY_PARAMETERS: Record<number, string | undefined> = {
  0x00: 'P-256',
  0x01: 'P-384',
  0x02: 'P-521',
  0x03: 'brainpoolP256r1',
  0x04: 'brainpoolP256t1',
  0x05: 'brainpoolP384r1',
  0x06: 'brainpoolP384t1',
  0x07: 'brainpoolP512r1',
  0x08: 'brainpoolP512t1',
};
const KEY_TYPES: Record<number, string | undefined> = {
  0x80: '3DES',
  0x81: '3DES',
  0x82: '3DES-CBC',
  0x83: 'DES-ECB',
  0x84: 'DES-CBC',
  0x85: 'PSK-TLS',
  0x88: 'AES',
  0x90: 'HMAC-SHA1',
  0x91: 'HMAC-SHA1-160',
  0xa0: 'RSA public exponent',
  0xa1: 'RSA modulus',
  0xa2: 'RSA private modulus',
  0xa3: 'RSA private exponent',
  0xa4: 'RSA CRT P',
  0xa5: 'RSA CRT Q',
  0xa6: 'RSA CRT PQ',
  0xa7: 'RSA CRT DP1',
  0xa8: 'RSA CRT DQ1',
  0xb0: 'EC public key',
  0xb1: 'EC private key',
  0xb2: 'EC field P',
  0xb3: 'EC field A',
  0xb4: 'EC field B',
  0xb5: 'EC generator',
  0xb6: 'EC order',
  0xb7: 'EC cofactor',
  0xf0: 'EC parameters',
};

function readSingleField(data: Uint8Array, tag: number): Uint8Array {
  const fields = readTLV(data);

  if (fields.length !== 1 || fields[0].tag !== tag) {
    throw new Error('Invalid card information response');
  }

  return fields[0].value;
}

function parseObjectIdentifier(data: Uint8Array): string {
  const values: bigint[] = [];
  let value = BigInt(0);

  for (const byte of data) {
    if (value === BigInt(0) && byte === 0x80) {
      throw new Error('Invalid card object identifier');
    }

    value = (value << BigInt(7)) | BigInt(byte & 0x7f);

    if (!(byte & 0x80)) {
      values.push(value);
      value = BigInt(0);
    }
  }

  if (!values.length || data[data.length - 1] & 0x80) {
    throw new Error('Incomplete card object identifier');
  }

  const first =
    values[0] < BigInt(40)
      ? BigInt(0)
      : values[0] < BigInt(80)
        ? BigInt(1)
        : BigInt(2);

  return [first, values[0] - first * BigInt(40), ...values.slice(1)].join('.');
}
