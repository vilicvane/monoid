import {InvalidCardItemError} from '../../../@lib/card-item-error.js';
import type {CardItem, MonoidApplet} from '../../../@lib/monoid/index.js';
import {
  SECURITY_KEY_ITEM_TYPE,
  decodeSecurityKeyCredentialItem,
} from '../../../@lib/security-key.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../../@utils/index.js';

import {
  decodeCardDerivationRecord,
  getCardDerivationItemIndex,
  isCardDerivationItem,
  readCardDerivationItem,
} from './card-derivations.js';
import {isCardOTPItem, validateCardOTPItem} from './card-otp.js';
import type {ScannedCardItemData} from './common.js';

export function isCardRecord(item: CardItem): boolean {
  return (
    isCardDerivationItem(item) ||
    isCardCredentialItem(item) ||
    isCardOTPItem(item)
  );
}

function isCardCredentialItem(item: CardItem): boolean {
  return Number.parseInt(item.index.slice(0, 4), 16) === SECURITY_KEY_ITEM_TYPE;
}

/** Transfer reads preserve bytes; only a usable wallet list gets a merge rule. */
export async function readOpaqueCardItem(
  applet: MonoidApplet,
  item: ScannedCardItemData,
): Promise<ScannedCardItemData & {data?: string}> {
  if (item.secret) return item;

  const {data} = await applet.get({index: hexToUint8Array(item.index)});
  return withCardDerivationRecord({...item, data: uint8ArrayToHex(data)});
}

export function withCardDerivationRecord<
  T extends ScannedCardItemData & {data?: string},
>(item: T): T {
  if (!item.secret && item.data !== undefined && isCardDerivationItem(item)) {
    try {
      const derivationRecord = decodeCardDerivationRecord(
        hexToUint8Array(item.data),
      );
      if (
        derivationRecord.index === item.metadata &&
        getCardDerivationItemIndex(derivationRecord.index) === item.index
      )
        return {...item, derivationRecord};
    } catch (error) {
      if (!(error instanceof InvalidCardItemError)) throw error;
    }
  }
  return item;
}

/** Keys keep their public List fields; only public records need payload reads. */
export async function decodeCardRecord(
  applet: MonoidApplet,
  item: CardItem,
): Promise<ScannedCardItemData> {
  if (isCardOTPItem(item)) {
    validateCardOTPItem(item);
    return item;
  }

  if (isCardDerivationItem(item)) {
    const record = await readCardDerivationItem(applet, item);
    return {
      ...item,
      derivationRecord: record.derivationRecord,
    };
  }

  if (item.secret) {
    if (isCardCredentialItem(item)) decodeSecurityKeyCredentialItem(item);
    return item;
  }

  if (isCardCredentialItem(item)) {
    const {data} = await applet.get({index: hexToUint8Array(item.index)});
    const record = {...item, data: uint8ArrayToHex(data)};
    decodeSecurityKeyCredentialItem(record);
  }

  return item;
}
