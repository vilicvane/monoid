import {BITCOIN_ADDRESS_TYPES} from '../../../@lib/bitcoin-wallet.js';
import {
  type BitcoinSubmission,
  type WalletKeyData,
  getKeyWallets,
} from '../../../@services/index.js';

export function getBitcoinRecipients(
  keys: readonly WalletKeyData[],
  submissions: readonly BitcoinSubmission[],
): {addresses: Set<string>; recent: string[]} {
  const owned = new Set(
    keys
      .flatMap(getKeyWallets)
      .flatMap(wallet =>
        BITCOIN_ADDRESS_TYPES.some(type => type === wallet.addressType)
          ? [wallet.address]
          : [],
      ),
  );
  const recent = [
    ...new Set(
      submissions.flatMap(submission =>
        submission.payment &&
        (submission.status === 'submitted' ||
          submission.status === 'confirmed') &&
        !owned.has(submission.payment.recipient)
          ? [submission.payment.recipient]
          : [],
      ),
    ),
  ];

  return {addresses: new Set([...owned, ...recent]), recent};
}
