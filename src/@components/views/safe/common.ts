import type {
  MonoidAppletIdHex,
  PublicKeyHex,
  SafeIndexHex,
  SafeKnownType,
} from '../../../@atomics.js';

export type ScannedCardKeyData = {
  type: SafeKnownType;
  alias: string | undefined;
  index: SafeIndexHex;
  refPublicKey: PublicKeyHex;
};

export type ScannedCardData = {
  id: MonoidAppletIdHex;
  keys: ScannedCardKeyData[];
};
