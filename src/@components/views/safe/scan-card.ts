import type {BIP39PathString, CurveName} from '../../../@atomics.js';
import {SafeKnownType} from '../../../@atomics.js';
import {
  ETHEREUM_CURVE,
  ETHEREUM_DERIVATION_PATH,
  ETHEREUM_SEED,
} from '../../../@constants.js';
import {parseDerivationPath} from '../../../@lib/bip39.js';
import {CBORAppletError} from '../../../@lib/cbor-applet.js';
import type {MonoidApplet} from '../../../@lib/monoid/index.js';
import {
  computeEthereumAddress,
  uint8ArrayToHex,
} from '../../../@utils/index.js';

import type {ScannedCardKeyData} from './common.js';

export async function scanCardKeys(
  applet: MonoidApplet,
  onProgress: (index: number, total: number) => void,
): Promise<ScannedCardKeyData[]> {
  const keys: ScannedCardKeyData[] = [];

  let {items} = await applet.list({});

  items = items.filter(item =>
    Object.hasOwn(SAFE_ITEM_TYPE_TO_VIEW_KEY_OPTIONS, item.type),
  );

  for (const [index, item] of items.entries()) {
    onProgress(index, items.length);

    const options = SAFE_ITEM_TYPE_TO_VIEW_KEY_OPTIONS[item.type];

    const metadata = await applet
      .viewKey({
        index: item.index,
        ...options,
        ...('path' in options && {
          path: parseDerivationPath(options.path),
        }),
      })
      .catch(error => {
        if (
          error instanceof CBORAppletError &&
          error.source.code.startsWith('UNSUPPORTED_')
        ) {
          return undefined;
        }

        throw error;
      });

    if (!metadata) {
      continue;
    }

    const publicKeyHex = uint8ArrayToHex(metadata.publicKey);
    const address = computeEthereumAddress(publicKeyHex);

    keys.push({
      type: SafeKnownType.satisfies(item.type),
      alias: item.alias,
      index: uint8ArrayToHex(item.index),
      ref: {
        ...('path' in options ? options : {}),
        publicKey: publicKeyHex,
        address,
      },
    });
  }

  return keys;
}

type ViewKeyOptions =
  | {
      seed?: string;
      curve: CurveName;
      path: BIP39PathString;
    }
  | {};

const SAFE_ITEM_TYPE_TO_VIEW_KEY_OPTIONS: Record<string, ViewKeyOptions> = {
  seed: {
    seed: ETHEREUM_SEED,
    curve: ETHEREUM_CURVE,
    path: ETHEREUM_DERIVATION_PATH(),
  },
  master: {
    curve: ETHEREUM_CURVE,
    path: ETHEREUM_DERIVATION_PATH(),
  },
  secp256k1: {},
};
