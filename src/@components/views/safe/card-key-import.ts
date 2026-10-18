import {runInAction} from 'mobx';

import type {
  WalletKeyData,
  WalletKeyPublicKeyData,
  WalletStorageService,
} from '../../../@services/index.js';
// eslint-disable-next-line @mufan/import -- Keep key import logic independent of UI services.
import {
  WalletKeyKnownType,
  assertWalletPublicKeys,
  getWalletReference,
  matchesWalletReference,
} from '../../../@services/wallet-storage-service.js';

import type {ScannedCardKeyData} from './common.js';

export function getCardKeyData(
  key: Omit<ScannedCardKeyData, 'ref'> & {ref?: ScannedCardKeyData['ref']},
  wallets?: readonly WalletKeyPublicKeyData[],
): WalletKeyData {
  const reference = key.ref && {
    addressType: key.ref.addressType,
    seed: key.ref.seed,
    curve: key.ref.curve,
    path: key.ref.path,
    publicKey: key.ref.publicKey,
  };
  const selected = wallets ?? (reference ? [reference] : []);
  assertWalletPublicKeys(selected);
  const data: WalletKeyData = {
    type: WalletKeyKnownType.satisfies(key.type),
    index: key.index,
    alias: key.alias,
    wallets: [],
  };

  for (const source of selected) {
    if (!data.wallets.some(wallet => matchesWalletReference(wallet, source))) {
      data.wallets.push({
        ...getWalletReference(source),
        publicKey: source.publicKey,
      });
    }
  }

  if (
    reference &&
    data.wallets.some(wallet => matchesWalletReference(wallet, reference))
  ) {
    data.defaultWallet = getWalletReference(reference);
  }

  return data;
}

export function importCardKey(
  service: WalletStorageService,
  incoming: WalletKeyData,
): void {
  runInAction(() => {
    const existing = service.indexToKeyMap.get(incoming.index);
    assertWalletPublicKeys([...(existing?.wallets ?? []), ...incoming.wallets]);

    if (!existing) {
      service.keys.push(incoming);
      return;
    }

    if (existing.type !== incoming.type) {
      throw new Error('Key type does not match');
    }
    if (incoming.alias !== undefined) {
      existing.alias = incoming.alias;
    }

    for (const source of incoming.wallets) {
      service.addWallet(existing.index, source);
    }

    if (
      existing.defaultWallet &&
      !existing.wallets.some(wallet =>
        matchesWalletReference(wallet, existing.defaultWallet!),
      )
    ) {
      delete existing.defaultWallet;
    }
  });
}

export function isWalletKeyUpToDate(
  incoming: WalletKeyData,
  existing: WalletKeyData,
): boolean {
  return (
    existing.type === incoming.type &&
    (incoming.alias === undefined ||
      (existing.alias ?? '') === incoming.alias) &&
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
