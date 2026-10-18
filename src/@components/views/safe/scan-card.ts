import {SafeKnownType} from '../../../@atomics.js';
import {CBORAppletError} from '../../../@lib/cbor-applet.js';
import type {MonoidApplet} from '../../../@lib/monoid/index.js';
// eslint-disable-next-line @mufan/import -- Keep card scanning independent of UI services.
import {getWalletData} from '../../../@services/wallet-storage-service.js';
import {uint8ArrayToHex} from '../../../@utils/index.js';

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
  onProgress: (index: number, total: number) => void,
): Promise<ScannedCardItemData[]> {
  const {items} = await applet.list({});
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
      getCardKeyAddressTypes(item.type).length > 0,
  );
  const derivationItems = scannedItems.filter(isCardDerivationItem);
  const records = new Map<string, CardDerivationRecord>();
  const total = derivationItems.length + keys.length;

  for (const [index, item] of derivationItems.entries()) {
    onProgress(index, total);

    const record = await readCardDerivationRecord(applet, item);
    item.derivationRecord = record;
    records.set(record.index, record);
  }

  for (const [index, item] of keys.entries()) {
    onProgress(derivationItems.length + index, total);

    const type = SafeKnownType.satisfies(item.type);
    const key = {type, index: item.index};

    if (type === 'seed' || type === 'master') {
      item.derivations = [];
      const record = records.get(item.index);

      if (record?.wallets.length) {
        item.derivations = await readCardWalletDerivations(
          applet,
          key,
          record.wallets,
        );
        const first = item.derivations[0];
        item.ref = {...first, address: getWalletData(first).address};
        continue;
      }
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

    if (ref) {
      item.ref = ref;
    }
  }

  return scannedItems;
}
