import {runInAction} from 'mobx';

import type {PublicKeyHex} from '../../../@atomics.js';
import {
  type DerivedKeyPublicKeyData,
  getSeedKeyDerivationId,
  mergeDerivedPublicKeys,
  normalizeKeyPublicKey,
} from '../../../@lib/key-derivation.js';
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
import {hexToUint8Array} from '../../../@utils/index.js';

import type {ScannedCardKeyData} from './common.js';

export function getCardKeyData(
  key: Omit<ScannedCardKeyData, 'ref'> & {
    ref?: ScannedCardKeyData['ref'];
    publicKey?: PublicKeyHex;
    derivedKeys?: DerivedKeyPublicKeyData[];
  },
  wallets?: readonly WalletKeyPublicKeyData[],
): WalletKeyData {
  const reference = key.ref && {
    addressType: key.ref.addressType,
    seed: key.ref.seed,
    curve: key.ref.curve,
    path: key.ref.path,
    publicKey: key.ref.publicKey,
  };
  const selected =
    wallets ?? (key.type !== 'ed25519' && reference ? [reference] : []);
  assertWalletPublicKeys(selected);
  const data: WalletKeyData = {
    type: WalletKeyKnownType.satisfies(key.type),
    index: key.index,
    alias: key.alias,
    wallets: [],
  };

  const nativePublicKey =
    key.publicKey ??
    (key.type === 'ed25519' && key.ref?.path === undefined
      ? key.ref?.publicKey
      : undefined);
  if ((key.type === 'secp256r1' || key.type === 'ed25519') && nativePublicKey) {
    data.rawPublicKey = normalizeKeyPublicKey(
      key.type === 'ed25519' ? 'ed25519' : 'secp256r1',
      hexToUint8Array(nativePublicKey),
    );
  }
  if (key.type === 'seed' && key.derivedKeys !== undefined) {
    data.derivedKeys = mergeDerivedPublicKeys(key.derivedKeys);
  }

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
    if (incoming.derivedKeys !== undefined && incoming.type !== 'seed')
      throw new Error('Key derivation requires a seed.');
    const derivedKeys =
      incoming.derivedKeys === undefined
        ? undefined
        : mergeDerivedPublicKeys(
            existing?.derivedKeys ?? [],
            incoming.derivedKeys,
          );

    if (!existing) {
      service.keys.push({
        ...incoming,
        ...(derivedKeys !== undefined && {derivedKeys}),
      });
      return;
    }

    if (existing.type !== incoming.type) {
      throw new Error('Key type does not match');
    }
    if (
      incoming.rawPublicKey &&
      existing.rawPublicKey &&
      incoming.rawPublicKey !== existing.rawPublicKey
    ) {
      throw new Error('Key public key does not match');
    }
    if (incoming.rawPublicKey) existing.rawPublicKey = incoming.rawPublicKey;
    if (derivedKeys !== undefined) existing.derivedKeys = derivedKeys;
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
    (incoming.rawPublicKey === undefined ||
      incoming.rawPublicKey === existing.rawPublicKey) &&
    (incoming.derivedKeys ?? []).every(source =>
      existing.derivedKeys?.some(
        saved =>
          saved.publicKey === source.publicKey &&
          getSeedKeyDerivationId(saved.derivation) ===
            getSeedKeyDerivationId(source.derivation),
      ),
    ) &&
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
