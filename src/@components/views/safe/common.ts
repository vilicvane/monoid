import type {
  BIP39PathString,
  CurveName,
  EthereumAddress,
  MonoidAppletIdHex,
  PublicKeyHex,
  SafeIndexHex,
  SafeKnownType,
} from '../../../@atomics.js';

export type ScannedCardKeyData = {
  type: SafeKnownType;
  index: SafeIndexHex;
  alias: string | undefined;
  ref: {
    seed?: string;
    curve?: CurveName;
    path?: BIP39PathString;
    publicKey: PublicKeyHex;
    address: EthereumAddress;
  };
};

export type ScannedCardData = {
  id: MonoidAppletIdHex;
  keys: ScannedCardKeyData[];
};
