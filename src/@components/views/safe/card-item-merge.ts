import {MonoidCardError} from '../../../@lib/monoid/card-error.js';
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

export type CardItemMergeData = {
  index: string;
  secret: boolean;
  key?: string;
  data?: string;
  derivationRecord?: CardDerivationRecord;
};

export class CardItemMergeConflict extends MonoidCardError {
  constructor(index: string) {
    super(`Item ${index}: conflicting credential data`);
  }
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
      item.key === undefined ||
      item.data === undefined ||
      ![item.index, item.key, item.data].every(value =>
        /^(?:[0-9a-f]{2})+$/i.test(value),
      )
    )
      throw new MonoidCardError('Invalid Security Key credential');
    decodeSecurityKeyCredential(
      hexToUint8Array(item.data),
      hexToUint8Array(item.index),
      hexToUint8Array(item.key),
    );
  } catch (error) {
    if (!(error instanceof MonoidCardError)) throw error;
    throw new MonoidCardError(
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
  if (isCardCredentialItem(first)) {
    validateCardCredentialItem(first);
    validateCardCredentialItem(next);
    if (first.key !== next.key || first.data !== next.data) {
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
