import {SafeKnownType} from '../../../@atomics.js';
import {CBORAppletError} from '../../../@lib/cbor-applet.js';
import type {MonoidApplet} from '../../../@lib/monoid/index.js';
import {uint8ArrayToHex} from '../../../@utils/index.js';

import {getCardKeyAddressTypes, readCardKeyAddress} from './card-address.js';
import type {ScannedCardItemData} from './common.js';

export async function scanCardItems(
  applet: MonoidApplet,
  onProgress: (index: number, total: number) => void,
): Promise<ScannedCardItemData[]> {
  const {items} = await applet.list({});
  const scannedItems: ScannedCardItemData[] = items.map(
    ({index, type, alias, key, secret}) => ({
      index: uint8ArrayToHex(index),
      ...(type !== undefined && {type}),
      ...(alias !== undefined && {alias}),
      ...(key !== undefined && {key: uint8ArrayToHex(key)}),
      secret,
    }),
  );
  const keys = scannedItems.filter(
    item =>
      typeof item.type === 'string' &&
      getCardKeyAddressTypes(item.type).length > 0,
  );

  for (const [index, item] of keys.entries()) {
    onProgress(index, keys.length);

    const type = SafeKnownType.satisfies(item.type);
    const ref = await readCardKeyAddress(
      applet,
      {type, index: item.index},
      getCardKeyAddressTypes(type)[0],
    ).catch(error => {
      if (
        error instanceof CBORAppletError &&
        error.source.code.startsWith('UNSUPPORTED_')
      ) {
        return undefined;
      }

      throw error;
    });

    if (ref) {
      item.ref = ref;
    }
  }

  return scannedItems;
}
