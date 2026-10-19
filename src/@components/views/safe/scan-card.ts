import {SafeKnownType} from '../../../@atomics.js';
import {CBORAppletError} from '../../../@lib/cbor-applet.js';
import type {MonoidApplet} from '../../../@lib/monoid/index.js';
// eslint-disable-next-line @mufan/import -- Keep card scanning independent of UI services.
import {getWalletData} from '../../../@services/wallet-storage-service.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../../@utils/index.js';

import {
  getCardKeyAddressTypes,
  readCardKeyAddress,
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
  const keys = scannedItems.filter(
    item =>
      typeof item.type === 'string' &&
      (getCardKeyAddressTypes(item.type).length > 0 ||
        item.type === 'secp256r1'),
  );
  const derivationItems = scannedItems.filter(isCardDerivationItem);
  const records = new Map<string, CardDerivationRecord>();

  if (derivationItems.length > 0) {
    onProgress(0, derivationItems.length, 'records');
  }

  for (const [index, item] of derivationItems.entries()) {
    assertActive();
    const record = await readCardDerivationRecord(applet, item);
    assertActive();
    item.derivationRecord = record;
    records.set(record.index, record);
    onProgress(index + 1, derivationItems.length, 'records');
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
    onProgress(0, total, 'keys');
  }

  for (const item of keys) {
    assertActive();
    const type = SafeKnownType.satisfies(item.type);
    const key = {type, index: item.index};

    if (type === 'secp256r1') {
      const {publicKey} = await applet.viewKey({
        type: 'secp256r1',
        index: hexToUint8Array(item.index),
      });
      assertActive();
      item.publicKey = uint8ArrayToHex(publicKey);
      onProgress(++completed, total, 'keys');
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
          onProgress(completed + current, total, 'keys');
        },
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

    const ref = await readCardKeyAddress(
      applet,
      key,
      getCardKeyAddressTypes(type)[0],
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

    if (ref) {
      item.ref = ref;
    }
    onProgress(++completed, total, 'keys');
  }

  assertActive();
  return scannedItems;
}
