import {SafeKnownType} from '../../../@atomics.js';
import {CBORAppletError} from '../../../@lib/cbor-applet.js';
import {InvalidCardItemError} from '../../../@lib/card-item-error.js';
import type {MonoidApplet} from '../../../@lib/monoid/index.js';
import {ADDRESS_TYPES} from '../../../@lib/wallet-address.js';
// eslint-disable-next-line @mufan/import -- Keep card scanning independent of UI services.
import {
  type WalletKeyData,
  getWalletData,
  matchesWalletReference,
} from '../../../@services/wallet-storage-service.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../../@utils/index.js';

import {
  getCardKeyAddressTypes,
  getLocalCardWalletDerivation,
  readCardWalletDerivations,
} from './card-address.js';
import {
  type CardDerivationRecord,
  filterCardDerivationAssociations,
  isCardDerivationItem,
  readCardDerivationRecord,
} from './card-derivations.js';
import {
  isCardCredentialItem,
  validateCardCredentialItem,
} from './card-item-merge.js';
import {
  filterCardOTPAssociations,
  isCardOTPItem,
  readCardOTPKeyIndex,
} from './card-otp.js';
import type {ScannedCardItemData} from './common.js';

export async function scanCardItems(
  applet: MonoidApplet,
  onProgress: (
    current: number,
    total: number,
    stage: 'records' | 'keys',
  ) => void,
  signal?: AbortSignal,
  localKeys: readonly WalletKeyData[] = [],
): Promise<ScannedCardItemData[]> {
  const assertActive = (): void => {
    if (signal?.aborted) {
      throw Object.assign(new Error('Card scan was cancelled'), {
        code: 'CANCELLED',
      });
    }
  };

  assertActive();
  const {items} = await applet.list({});
  assertActive();
  const scannedItems: ScannedCardItemData[] = items.map(
    ({index, type, alias, metadata, secret}) => ({
      index: uint8ArrayToHex(index),
      ...(type !== undefined && {type}),
      ...(alias !== undefined && {alias}),
      ...(metadata !== undefined && {metadata: uint8ArrayToHex(metadata)}),
      secret,
    }),
  );
  const derivationItems = scannedItems.filter(
    item =>
      isCardDerivationItem(item) ||
      isCardOTPItem(item) ||
      isCardCredentialItem(item),
  );

  if (derivationItems.length > 0) {
    onProgress(0, derivationItems.length, 'records');
  }

  const incompatible = new Set<ScannedCardItemData>();
  for (const [index, item] of derivationItems.entries()) {
    assertActive();
    try {
      if (isCardOTPItem(item)) {
        item.otpKeyIndex = await readCardOTPKeyIndex(applet, item);
      } else if (isCardCredentialItem(item)) {
        if (item.secret)
          throw new InvalidCardItemError('Invalid Security Key credential');
        const {data} = await applet.get({index: hexToUint8Array(item.index)});
        validateCardCredentialItem({...item, data: uint8ArrayToHex(data)});
      } else {
        item.derivationRecord = await readCardDerivationRecord(applet, item);
      }
    } catch (error) {
      if (!(error instanceof InvalidCardItemError)) throw error;
      incompatible.add(item);
    }
    assertActive();
    onProgress(index + 1, derivationItems.length, 'records');
  }
  const compatibleItems = filterCardOTPAssociations(
    filterCardDerivationAssociations(
      scannedItems.filter(item => !incompatible.has(item)),
    ),
  );

  return readCardAddressPreviews(
    applet,
    compatibleItems,
    (current, total) => onProgress(current, total, 'keys'),
    signal,
    [],
    localKeys,
  );
}

/** Load one display preview per key; recorded addresses stay lazy until import. */
export async function readCardAddressPreviews(
  applet: MonoidApplet,
  items: readonly ScannedCardItemData[],
  onProgress: (current: number, total: number) => void,
  signal?: AbortSignal,
  knownItems: readonly ScannedCardItemData[] = [],
  localKeys: readonly WalletKeyData[] = [],
): Promise<ScannedCardItemData[]> {
  const assertActive = (): void => {
    if (signal?.aborted) {
      throw Object.assign(new Error('Card scan was cancelled'), {
        code: 'CANCELLED',
      });
    }
  };

  assertActive();
  const scannedItems = items.map(item => ({...item}));
  const keys = scannedItems.filter(
    item =>
      typeof item.type === 'string' &&
      (getCardKeyAddressTypes(item.type).length > 0 ||
        item.type === 'secp256r1'),
  );
  const records = new Map<string, CardDerivationRecord>();

  for (const item of scannedItems.filter(isCardDerivationItem)) {
    if (!item.derivationRecord)
      throw new Error('Address records were not read');
    records.set(item.derivationRecord.index, item.derivationRecord);
  }

  const previews = keys.map(item => {
    const localKey = localKeys.find(
      key => key.index === item.index && key.type === item.type,
    );
    const localWallet =
      localKey?.wallets.find(
        wallet =>
          localKey.defaultWallet &&
          matchesWalletReference(wallet, localKey.defaultWallet),
      ) ?? localKey?.wallets[0];
    const record = records.get(item.index);
    const readDefault =
      item.type === 'secp256r1' ||
      (!localWallet && record?.wallets.length !== 0);
    return {item, localKey, localWallet, record, readDefault};
  });
  const total = previews.filter(preview => preview.readDefault).length;
  let completed = 0;

  if (total > 0) {
    assertActive();
    onProgress(0, total);
  }

  for (const {item, localKey, localWallet, record, readDefault} of previews) {
    assertActive();
    const type = SafeKnownType.satisfies(item.type);
    const key = {type, index: item.index};
    const known = knownItems.find(
      source => source.index === item.index && source.type === item.type,
    );
    const knownWallets = [
      ...(localKey?.wallets ?? []),
      ...(known?.derivations ?? []),
      ...(known?.ref
        ? [
            {
              addressType: known.ref.addressType,
              seed: known.ref.seed,
              curve: known.ref.curve,
              path: known.ref.path,
              publicKey: known.ref.publicKey,
            },
          ]
        : []),
    ];
    delete item.ref;
    delete item.derivations;
    delete item.publicKey;

    if (type === 'secp256r1') {
      const publicKey =
        known?.publicKey ??
        uint8ArrayToHex(
          (
            await applet.viewKey({
              type: 'secp256r1',
              index: hexToUint8Array(item.index),
            })
          ).publicKey,
        );
      assertActive();
      item.publicKey = publicKey;
      onProgress(++completed, total);
      continue;
    }

    let preview = localWallet;
    if (readDefault) {
      const addressType = getCardKeyAddressTypes(type)[0];
      const options = ADDRESS_TYPES[addressType];
      const derivations = await readCardWalletDerivations(
        applet,
        key,
        [
          {
            addressType,
            seed: type === 'seed' ? options.seed : undefined,
            curve: type === 'seed' ? options.curve : undefined,
            path: type === 'seed' ? options.path(0) : undefined,
          },
        ],
        signal,
        undefined,
        knownWallets,
      ).catch(error => {
        if (
          error instanceof CBORAppletError &&
          error.source.code.startsWith('UNSUPPORTED_')
        ) {
          return undefined;
        }

        throw error;
      });
      assertActive();
      preview = derivations?.[0];
    }

    if (preview) {
      item.ref = {
        addressType: preview.addressType,
        ...(preview.seed !== undefined && {seed: preview.seed}),
        ...(preview.path !== undefined && {
          curve: preview.curve,
          path: preview.path,
        }),
        publicKey: preview.publicKey,
        address: getWalletData(preview).address,
      };
    }
    if (record) {
      const available = preview ? [...knownWallets, preview] : knownWallets;
      item.derivations = record.wallets.flatMap(parameters => {
        const known = getLocalCardWalletDerivation(available, parameters);
        return known ? [known] : [];
      });
    } else if (type === 'seed') {
      item.derivations = [];
    }
    if (readDefault) onProgress(++completed, total);
  }

  assertActive();
  return scannedItems;
}
