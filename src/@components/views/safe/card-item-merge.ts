import {InvalidCardItemError} from '../../../@lib/card-item-error.js';
import {MonoidCardError} from '../../../@lib/monoid/index.js';
import {
  SECURITY_KEY_ITEM_TYPE,
  decodeSecurityKeyCredential,
} from '../../../@lib/security-key.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../../@utils/index.js';

import {
  type CardDerivationRecord,
  encodeCardDerivationRecord,
  mergeCardDerivationWallets,
} from './card-derivations.js';
import {isCardOTPItem, validateCardOTPItem} from './card-otp.js';

export type CardItemMergeData = {
  index: string;
  secret: boolean;
  metadata?: string;
  data?: string;
  derivationRecord?: CardDerivationRecord;
};

export class CardItemMergeConflict extends MonoidCardError {
  constructor(index: string, kind = 'credential') {
    super(`Item ${index}: conflicting ${kind} data`);
  }
}

export function isCardImmutableItem(item: {index: string}): boolean {
  return isCardCredentialItem(item) || isCardOTPItem(item);
}

export function validateCardImmutableItem(item: CardItemMergeData): void {
  if (isCardOTPItem(item)) validateCardOTPItem(item);
  else validateCardCredentialItem(item);
}

export function isCardCredentialItem(item: {index: string}): boolean {
  return Number.parseInt(item.index.slice(0, 4), 16) === SECURITY_KEY_ITEM_TYPE;
}

/** Scope-bound public records travel intact; older records are never claimed. */
export function validateCardCredentialItem(item: CardItemMergeData): void {
  if (!isCardCredentialItem(item)) return;
  try {
    if (
      item.secret ||
      item.metadata === undefined ||
      item.data === undefined ||
      ![item.index, item.metadata, item.data].every(value =>
        /^(?:[0-9a-f]{2})+$/i.test(value),
      )
    )
      throw new InvalidCardItemError('Invalid Security Key credential');
    decodeSecurityKeyCredential(
      hexToUint8Array(item.data),
      hexToUint8Array(item.index),
      hexToUint8Array(item.metadata),
    );
  } catch (error) {
    if (!(error instanceof InvalidCardItemError)) throw error;
    throw new InvalidCardItemError(
      `Item ${item.index}: invalid Security Key credential`,
      {cause: error},
    );
  }
}

/** Merge one shared index; separate credential indices remain separate items. */
export function mergeCardItemData<T extends CardItemMergeData>(
  first: T,
  next: CardItemMergeData,
): T {
  if (isCardOTPItem(first)) {
    validateCardOTPItem(first);
    validateCardOTPItem(next);
    if (first.metadata !== next.metadata)
      throw new CardItemMergeConflict(first.index, 'OTP');
    return first;
  }

  if (isCardCredentialItem(first)) {
    validateCardCredentialItem(first);
    validateCardCredentialItem(next);
    if (first.metadata !== next.metadata || first.data !== next.data) {
      throw new CardItemMergeConflict(first.index);
    }
    return first;
  }

  if (first.derivationRecord && next.derivationRecord) {
    const derivationRecord = {
      index: first.derivationRecord.index,
      wallets: mergeCardDerivationWallets(
        first.derivationRecord.wallets,
        next.derivationRecord.wallets,
      ),
    };
    return {
      ...first,
      derivationRecord,
      data: uint8ArrayToHex(encodeCardDerivationRecord(derivationRecord)),
    };
  }

  return first;
}
