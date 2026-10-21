import {SafeKnownType} from '../../../@atomics.js';
import {CBORAppletError} from '../../../@lib/cbor-applet.js';
import type {MonoidApplet} from '../../../@lib/monoid/index.js';
import {ADDRESS_TYPES} from '../../../@lib/wallet-address.js';
// eslint-disable-next-line @mufan/import -- Keep card scanning independent of UI services.
import {getWalletData} from '../../../@services/wallet-storage-service.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../../@utils/index.js';

import {
  getCardKeyAddressTypes,
  readCardWalletDerivations,
} from './card-address.js';
import {
  type CardDerivationRecord,
  isCardDerivationItem,
  readCardDerivationRecord,
} from './card-derivations.js';
import type {ScannedCardItemData} from './common.js';

export async function scanCardItems(
  applet: MonoidApplet,
  onProgress: (
    current: number,
    total: number,
    stage: 'records' | 'keys',
  ) => void,
  signal?: AbortSignal,
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
    ({index, type, alias, key, secret}) => ({
      index: uint8ArrayToHex(index),
      ...(type !== undefined && {type}),
      ...(alias !== undefined && {alias}),
      ...(key !== undefined && {key: uint8ArrayToHex(key)}),
      secret,
    }),
  );
  const derivationItems = scannedItems.filter(isCardDerivationItem);

  if (derivationItems.length > 0) {
    onProgress(0, derivationItems.length, 'records');
  }

  for (const [index, item] of derivationItems.entries()) {
    assertActive();
    const record = await readCardDerivationRecord(applet, item);
    assertActive();
    item.derivationRecord = record;
    onProgress(index + 1, derivationItems.length, 'records');
  }

  return readCardAddressPreviews(
    applet,
    scannedItems,
    (current, total) => onProgress(current, total, 'keys'),
    signal,
  );
}

/** Hydrate already-read records without listing resources or rereading metadata. */
export async function readCardAddressPreviews(
  applet: MonoidApplet,
  items: readonly ScannedCardItemData[],
  onProgress: (current: number, total: number) => void,
  signal?: AbortSignal,
  knownItems: readonly ScannedCardItemData[] = [],
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

  const total = keys.reduce(
    (count, item) =>
      count +
      (item.type === 'secp256r1'
        ? 1
        : (records.get(item.index)?.wallets.length ?? 1)),
    0,
  );
  let completed = 0;

  if (total > 0) {
    assertActive();
    onProgress(0, total);
  }

  for (const item of keys) {
    assertActive();
    const type = SafeKnownType.satisfies(item.type);
    const key = {type, index: item.index};
    const known = knownItems.find(
      source => source.index === item.index && source.type === item.type,
    );
    const knownWallets = [
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

    const record = records.get(item.index);

    if (record) {
      item.derivations = await readCardWalletDerivations(
        applet,
        key,
        record.wallets,
        signal,
        current => {
          assertActive();
          onProgress(completed + current, total);
        },
        knownWallets,
      );
      assertActive();
      completed += record.wallets.length;
      const first = item.derivations[0];
      if (first) item.ref = {...first, address: getWalletData(first).address};
      continue;
    }

    if (type === 'seed') {
      item.derivations = [];
    }

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

    const first = derivations?.[0];
    if (first) {
      item.ref = {
        addressType: first.addressType,
        ...(first.seed !== undefined && {seed: first.seed}),
        ...(first.path !== undefined && {curve: first.curve, path: first.path}),
        publicKey: first.publicKey,
        address: getWalletData(first).address,
      };
    }
    onProgress(++completed, total);
  }

  assertActive();
  return scannedItems;
}
