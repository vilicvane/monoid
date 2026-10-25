import {CardItemConflictError} from '../../../@lib/monoid/index.js';
import {uint8ArrayToHex} from '../../../@utils/index.js';

import {
  type CardDerivationRecord,
  encodeCardDerivationRecord,
  mergeCardDerivationWallets,
} from './card-derivations.js';

export type CardItemMergeData = {
  index: string;
  type?: string | number;
  secret: boolean;
  metadata?: string;
  data?: string;
  derivationRecord?: CardDerivationRecord;
};

/** Merge one shared index; separate credential indices remain separate items. */
export function mergeCardItemData<T extends CardItemMergeData>(
  first: T,
  next: CardItemMergeData,
): T {
  if (
    first.index !== next.index ||
    first.type !== next.type ||
    first.secret !== next.secret ||
    first.metadata !== next.metadata
  ) {
    throw new CardItemConflictError(first.index);
  }

  if (first.data === next.data) return first;

  if (
    !first.secret &&
    first.derivationRecord &&
    next.derivationRecord &&
    first.derivationRecord.index === next.derivationRecord.index
  ) {
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

  throw new CardItemConflictError(first.index);
}
