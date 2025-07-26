import type {
  MonoidAppletId,
  PublicKey,
  SafeIndex,
  SafeKnownType,
} from '../../../@atomics.js';

export type ScannedCardKeyData = {
  type: SafeKnownType;
  index: SafeIndex;
  refPublicKey: PublicKey;
};

export type ScannedCardData = {
  id: MonoidAppletId;
  keys: ScannedCardKeyData[];
};
