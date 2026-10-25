import type {CardItem, MonoidApplet} from '../../../@lib/monoid/index.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../../@utils/index.js';

import {
  isCardDerivationItem,
  readCardDerivationItem,
} from './card-derivations.js';
import {
  isCardImmutableItem,
  validateCardImmutableItem,
} from './card-item-merge.js';
import {isCardOTPItem} from './card-otp.js';
import type {ScannedCardItemData} from './common.js';

export function isCardRecord(item: CardItem): boolean {
  return isCardDerivationItem(item) || isCardImmutableItem(item);
}

/** Keys keep their public List fields; only public records need payload reads. */
export async function decodeCardRecord(
  applet: MonoidApplet,
  item: CardItem,
  readPublicData = false,
): Promise<ScannedCardItemData & {data?: string}> {
  if (isCardOTPItem(item)) {
    validateCardImmutableItem(item);
    return item;
  }

  if (isCardDerivationItem(item)) {
    const record = await readCardDerivationItem(applet, item);
    return {
      ...item,
      derivationRecord: record.derivationRecord,
      ...(readPublicData && {data: record.data}),
    };
  }

  if (item.secret) {
    validateCardImmutableItem(item);
    return item;
  }

  if (readPublicData || isCardImmutableItem(item)) {
    const {data} = await applet.get({index: hexToUint8Array(item.index)});
    const record = {...item, data: uint8ArrayToHex(data)};
    validateCardImmutableItem(record);
    return readPublicData ? record : item;
  }

  return item;
}
