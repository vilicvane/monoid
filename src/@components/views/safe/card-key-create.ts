import {SafeKnownType} from '../../../@atomics.js';
import {CBORAppletError} from '../../../@lib/cbor-applet.js';
import {
  type MonoidApplet,
  MonoidCardError,
} from '../../../@lib/monoid/index.js';
import type {AddressType} from '../../../@lib/wallet-address.js';
import {uint8ArrayToHex} from '../../../@utils/index.js';

import {getCardKeyAddressTypes, readCardKeyAddress} from './card-address.js';
import type {ScannedCardItemData} from './common.js';

export const CARD_KEY_TYPES = [
  'seed',
  'master',
  'secp256k1',
  'secp256r1',
  'ed25519',
] as const;

export type CardKeyType = (typeof CARD_KEY_TYPES)[number];

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw Object.assign(new Error('Creating key was cancelled'), {
      code: 'CANCELLED',
    });
  }
}

export async function createCardKey(
  applet: MonoidApplet,
  type: CardKeyType,
  signal: AbortSignal,
  onUpdated: (item: ScannedCardItemData) => void,
  addressType: AddressType = getCardKeyAddressTypes(type)[0],
): Promise<void> {
  throwIfCancelled(signal);

  // A lost response can leave a key on the card. Never repeat this command.
  const {index} = await applet
    .createRandomKey({
      type,
      ...(type === 'seed'
        ? {length: 64}
        : type === 'master'
          ? {length: 32}
          : {}),
    })
    .catch(error => {
      if (error instanceof CBORAppletError) throw error;
      throw new MonoidCardError(
        'Creation not confirmed, rescan card to check',
        {
          cause: error,
        },
      );
    });

  const item: ScannedCardItemData = {
    index: uint8ArrayToHex(index),
    type,
    secret: true,
    ...((type === 'seed' || type === 'master') && {derivations: []}),
  };
  // Keep the acknowledged key even if reading it or closing the scan fails.
  onUpdated(item);
  throwIfCancelled(signal);

  const metadata = await applet.view({index});
  Object.assign(item, {
    secret: metadata.secret,
    ...(metadata.alias !== undefined && {alias: metadata.alias}),
    ...(metadata.key !== undefined && {key: uint8ArrayToHex(metadata.key)}),
  });
  onUpdated(item);
  throwIfCancelled(signal);

  if (type === 'secp256r1') {
    const {publicKey} = await applet.viewKey({type, index});
    item.publicKey = uint8ArrayToHex(publicKey);
  } else {
    item.ref = await readCardKeyAddress(
      applet,
      {index: item.index, type: SafeKnownType.satisfies(type)},
      addressType,
    );
  }
  onUpdated(item);
  throwIfCancelled(signal);
}
