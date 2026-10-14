import {SafeKnownType} from '../../../@atomics.js';
import {CBORAppletError} from '../../../@lib/cbor-applet.js';
import type {MonoidApplet} from '../../../@lib/monoid/index.js';
import {uint8ArrayToHex} from '../../../@utils/index.js';

import {getCardKeyAddressTypes, readCardKeyAddress} from './card-address.js';
import type {ScannedCardKeyData} from './common.js';

export async function scanCardKeys(
  applet: MonoidApplet,
  onProgress: (index: number, total: number) => void,
): Promise<ScannedCardKeyData[]> {
  const keys: ScannedCardKeyData[] = [];

  let {items} = await applet.list({});

  items = items.filter(
    item =>
      typeof item.type === 'string' &&
      getCardKeyAddressTypes(item.type).length > 0,
  );

  for (const [index, item] of items.entries()) {
    onProgress(index, items.length);

    const key = {
      type: SafeKnownType.satisfies(item.type),
      index: uint8ArrayToHex(item.index),
      alias: item.alias,
    };
    const ref = await readCardKeyAddress(
      applet,
      key,
      getCardKeyAddressTypes(key.type)[0],
    ).catch(error => {
      if (
        error instanceof CBORAppletError &&
        error.source.code.startsWith('UNSUPPORTED_')
      ) {
        return undefined;
      }

      throw error;
    });

    if (!ref) {
      continue;
    }

    keys.push({...key, ref});
  }

  return keys;
}
