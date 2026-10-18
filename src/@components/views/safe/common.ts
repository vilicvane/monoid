import type {
  BIP39PathString,
  CurveName,
  MonoidSafeIdHex,
  PublicKeyHex,
  SafeIndexHex,
  SafeKnownType,
} from '../../../@atomics.js';
import type {AddressType} from '../../../@lib/wallet-address.js';

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

export type ScannedCardData = {
  id: MonoidSafeIdHex;
  publicKey: PublicKeyHex;
  items: ScannedCardItemData[];
};

export type ScannedCardItemData = {
  index: SafeIndexHex;
  type?: string | number;
  alias?: string;
  key?: string;
  secret: boolean;
  ref?: ScannedCardKeyData['ref'];
};

export function isCardKeyItem(
  item: Pick<ScannedCardItemData, 'type'>,
): boolean {
  switch (item.type) {
    case 'entropy':
    case 'seed':
    case 'master':
    case 'secp256k1':
    case 'secp256r1':
    case 'ed25519':
      return true;
    default:
      return false;
  }
}
