import {runInAction} from 'mobx';

import type {
  WalletKeyData,
  WalletStorageService,
} from '../../../@services/index.js';
// eslint-disable-next-line @mufan/import -- Keep key import logic independent of UI services.
import {
  WalletKeyKnownType,
  getWalletReference,
} from '../../../@services/wallet-storage-service.js';

import type {ScannedCardKeyData} from './common.js';

export function getCardKeyData(
  key: ScannedCardKeyData,
  refs: readonly ScannedCardKeyData['ref'][] = [key.ref],
): WalletKeyData {
  const {addressType, seed, curve, path, publicKey} = key.ref;
  const source = {addressType, seed, curve, path, publicKey};
  const data: WalletKeyData = {
    type: WalletKeyKnownType.satisfies(key.type),
    index: key.index,
    alias: key.alias,
    wallets: [],
    defaultWallet: getWalletReference(source),
  };

  if (key.type === 'seed' || key.type === 'master') {
    data.wallets.push(source);
  } else if (key.type === 'secp256k1') {
    const ordinary = refs.find(
      ref => ref.addressType === 'evm' || ref.addressType === 'bitcoin-segwit',
    );
    const taproot = refs.find(ref => ref.addressType === 'bitcoin-taproot');

    if (ordinary) data.publicKey = ordinary.publicKey;
    if (taproot) data.taprootOutputKey = taproot.publicKey;
  } else {
    data.publicKey = publicKey;
  }

  return data;
}

export function importCardKey(
  service: WalletStorageService,
  incoming: WalletKeyData,
): void {
  runInAction(() => {
    const existing = service.indexToKeyMap.get(incoming.index);

    if (!existing) {
      service.keys.push(incoming);
      return;
    }

    existing.type = incoming.type;
    if (incoming.alias) {
      existing.alias = incoming.alias;
    }

    if (incoming.publicKey !== undefined) {
      existing.publicKey = incoming.publicKey;
    }
    if (incoming.taprootOutputKey !== undefined) {
      existing.taprootOutputKey = incoming.taprootOutputKey;
    }

    if (existing.type === 'seed' || existing.type === 'master') {
      for (const source of incoming.wallets) {
        service.addWallet(existing.index, source);
      }
    }
  });
}

export function isWalletKeyUpToDate(
  incoming: WalletKeyData,
  existing: WalletKeyData,
): boolean {
  return (
    existing.type === incoming.type &&
    (!incoming.alias || existing.alias === incoming.alias) &&
    (incoming.publicKey === undefined ||
      existing.publicKey === incoming.publicKey) &&
    (incoming.taprootOutputKey === undefined ||
      existing.taprootOutputKey === incoming.taprootOutputKey) &&
    incoming.wallets.every(source =>
      existing.wallets.some(
        saved =>
          saved.addressType === source.addressType &&
          saved.publicKey === source.publicKey &&
          saved.seed === source.seed &&
          saved.curve === source.curve &&
          saved.path === source.path,
      ),
    )
  );
}
