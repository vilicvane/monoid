import type {SafeIndexHex} from '../../../@atomics.js';
import {InvalidCardItemError} from '../../../@lib/card-item-error.js';
import type {MonoidApplet} from '../../../@lib/monoid/index.js';
import {
  decodeOTPConfiguration,
  decodeOTPKeyReference,
} from '../../../@lib/otp.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../../@utils/index.js';

import type {ScannedCardItemData} from './common.js';

export function isCardOTPItem(item: {index: string}): boolean {
  return item.index.slice(0, 4).toLowerCase() === 'f201';
}

export function isCardHMACItem(item: {index: string}): boolean {
  return /^05(?!00)[0-9a-f]{18}$/i.test(item.index);
}

type OTPRecord = {
  index: string;
  secret: boolean;
  metadata?: string;
  data?: string;
  otpKeyIndex?: SafeIndexHex;
};

export function validateCardOTPItem(item: OTPRecord): SafeIndexHex {
  try {
    if (
      !/^f201[0-9a-f]{16}$/i.test(item.index) ||
      item.secret ||
      !item.metadata ||
      !item.data ||
      ![item.metadata, item.data].every(value =>
        /^(?:[0-9a-f]{2})+$/i.test(value),
      )
    )
      throw new InvalidCardItemError('Invalid OTP account');
    decodeOTPConfiguration(hexToUint8Array(item.metadata));
    const index = decodeOTPKeyReference(hexToUint8Array(item.data));
    if (item.otpKeyIndex !== undefined && item.otpKeyIndex !== index)
      throw new InvalidCardItemError('OTP key reference changed');
    return index;
  } catch (cause) {
    throw new InvalidCardItemError(`Item ${item.index}: invalid OTP account`, {
      cause,
    });
  }
}

export async function readCardOTPKeyIndex(
  applet: MonoidApplet,
  item: Pick<ScannedCardItemData, 'index' | 'secret' | 'metadata'>,
): Promise<SafeIndexHex> {
  if (item.secret)
    throw new InvalidCardItemError(`Item ${item.index}: invalid OTP account`);
  const {data} = await applet.get({index: hexToUint8Array(item.index)});
  return validateCardOTPItem({...item, data: uint8ArrayToHex(data)});
}

type OTPAssociationItem = Pick<ScannedCardItemData, 'index' | 'otpKeyIndex'> & {
  secret?: boolean;
};

function assertCardOTPAssociation(
  item: OTPAssociationItem,
  items: readonly OTPAssociationItem[],
): void {
  if (!isCardOTPItem(item)) return;
  if (!item.otpKeyIndex || !isCardHMACItem({index: item.otpKeyIndex}))
    throw new InvalidCardItemError(
      `Item ${item.index}: invalid OTP key reference`,
    );
  const source = items.find(source => source.index === item.otpKeyIndex);
  if (!source)
    throw new InvalidCardItemError(
      `Item ${item.index}: associated key is missing`,
    );
  if (item.secret || !source.secret)
    throw new InvalidCardItemError(`Item ${item.index}: invalid OTP key`);
}

/** Account metadata follows its secret, including across mixed-bundle syncs. */
export function assertCardOTPAssociations(
  items: readonly OTPAssociationItem[],
): void {
  for (const item of items) {
    assertCardOTPAssociation(item, items);
  }
}

/** Skip unsupported account references without discarding their independent keys. */
export function filterCardOTPAssociations<T extends OTPAssociationItem>(
  items: readonly T[],
): T[] {
  return items.filter(item => {
    try {
      assertCardOTPAssociation(item, items);
      return true;
    } catch (error) {
      if (!(error instanceof InvalidCardItemError)) throw error;
      return false;
    }
  });
}
