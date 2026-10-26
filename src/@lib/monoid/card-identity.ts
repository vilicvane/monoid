import type {MonoidIdHex, PublicKeyHex} from '../../@atomics.js';
import {uint8ArrayToHex} from '../../@utils/index.js';

import {MonoidCardError, MonoidWrongCardError} from './card-error.js';
import type {MonoidAppletHello} from './monoid-applet.js';

export type CardIdentity = {id: MonoidIdHex; publicKey: PublicKeyHex};
export type CardDisplayData = Pick<
  MonoidAppletHello,
  'alias' | 'allowPeerExtension'
>;
export type CardBackupIdentity = CardIdentity & {
  bundle: string | false;
} & Partial<CardDisplayData>;

type CardIdentitySource =
  | Pick<MonoidAppletHello, 'id' | 'publicKey'>
  | CardIdentity;
type CardBundleIdentitySource =
  | Pick<MonoidAppletHello, 'id' | 'publicKey' | 'bundle'>
  | CardBackupIdentity;

export function readCardIdentity(card: CardIdentitySource): CardIdentity {
  return {
    id: typeof card.id === 'string' ? card.id : uint8ArrayToHex(card.id),
    publicKey:
      typeof card.publicKey === 'string'
        ? card.publicKey
        : uint8ArrayToHex(card.publicKey),
  };
}

export function readBackupCardIdentity(
  hello: MonoidAppletHello,
): CardBackupIdentity & CardDisplayData {
  const {id, publicKey, bundle} = hello;

  if (
    id.length !== 4 ||
    publicKey.length !== 65 ||
    publicKey[0] !== 0x04 ||
    (bundle !== false && bundle.length !== 32)
  ) {
    throw new MonoidCardError('This card did not provide a valid identity.');
  }

  return {
    ...readCardIdentity(hello),
    alias: hello.alias,
    allowPeerExtension: hello.allowPeerExtension,
    bundle: bundle === false ? false : uint8ArrayToHex(bundle),
  };
}

export function assertSameCard(
  hello: CardIdentitySource,
  identity: CardIdentity,
): void {
  const card = readCardIdentity(hello);

  if (card.id !== identity.id || card.publicKey !== identity.publicKey) {
    throw new MonoidWrongCardError(identity.id);
  }
}

export function assertSameCardWithBundle(
  hello: CardBundleIdentitySource,
  identity: CardBackupIdentity,
  bundleChangedMessage?: string,
): void {
  assertSameCard(hello, identity);

  const bundle =
    hello.bundle === false || typeof hello.bundle === 'string'
      ? hello.bundle
      : uint8ArrayToHex(hello.bundle);

  if (bundle !== identity.bundle) {
    throw bundleChangedMessage
      ? new MonoidCardError(bundleChangedMessage)
      : new MonoidWrongCardError(identity.id);
  }
}
