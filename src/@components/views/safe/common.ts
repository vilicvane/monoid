import type {
  BIP39PathString,
  CurveName,
  PublicKeyHex,
  SafeIndexHex,
  SafeKnownType,
} from '../../../@atomics.js';
import type {
  CardDisplayData,
  CardIdentity,
} from '../../../@lib/monoid/index.js';
import type {AddressType} from '../../../@lib/wallet-address.js';
import type {WalletKeyPublicKeyData} from '../../../@services/index.js';

import type {CardDerivationRecord} from './card-derivations.js';

export type ScannedCardKeyData = {
  type: SafeKnownType;
  index: SafeIndexHex;
  alias: string | undefined;
  ref: {
    addressType: AddressType;
    seed?: string;
    curve?: CurveName;
    path?: BIP39PathString;
    publicKey: PublicKeyHex;
    address: string;
  };
};

export type ScannedCardData = CardIdentity &
  CardDisplayData & {
    bundle: string | false;
    items: ScannedCardItemData[];
  };

export type ScannedCardItemData = {
  index: SafeIndexHex;
  type?: string | number;
  alias?: string;
  metadata?: string;
  secret: boolean;
  publicKey?: PublicKeyHex;
  ref?: ScannedCardKeyData['ref'];
  /** Cached public keys only; the companion derivationRecord holds the full saved list. */
  derivations?: WalletKeyPublicKeyData[];
  derivationRecord?: CardDerivationRecord;
};

export function isCardKeyItem(
  item: Pick<ScannedCardItemData, 'type'>,
): boolean {
  switch (item.type) {
    case 'entropy':
    case 'seed':
    case 'secp256k1':
    case 'secp256r1':
    case 'ed25519':
      return true;
    default:
      return false;
  }
}
