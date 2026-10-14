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
  keys: ScannedCardKeyData[];
};
