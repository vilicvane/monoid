import type {SafeIndexHex} from '../../@atomics.js';
import {uint8ArrayToHex} from '../../@utils/index.js';
import {InvalidCardItemError} from '../card-item-error.js';

import type {MonoidApplet} from './monoid-applet.js';

export type CardItem = {
  index: SafeIndexHex;
  type?: Awaited<ReturnType<MonoidApplet['list']>>['items'][number]['type'];
  alias?: string;
  metadata?: string;
  secret: boolean;
};

export type CardContents<T> = {
  items: T[];
  /** In List order; ignored feature types are not incompatible records. */
  skippedIndexes: SafeIndexHex[];
};

/** One operation-local List, followed only by the Gets required by its decoder. */
export async function readCardContents<T>(
  applet: MonoidApplet,
  decode: (item: CardItem) => T | undefined | Promise<T | undefined>,
  {
    filter = {},
    listed,
    check = () => {},
    onProgress,
    progressFilter = () => true,
  }: {
    filter?: Parameters<MonoidApplet['list']>[0];
    listed?: Awaited<ReturnType<MonoidApplet['list']>>;
    check?: () => void;
    onProgress?: (current: number, total: number) => void;
    progressFilter?: (item: CardItem) => boolean;
  } = {},
): Promise<CardContents<T>> {
  check();
  const {items: entries} = listed ?? (await applet.list(filter));
  check();
  const listedItems: CardItem[] = entries.map(
    ({index, type, alias, metadata, secret}) => ({
      index: uint8ArrayToHex(index),
      ...(type !== undefined && {type}),
      ...(alias !== undefined && {alias}),
      ...(metadata !== undefined && {metadata: uint8ArrayToHex(metadata)}),
      secret,
    }),
  );
  const total = listedItems.filter(progressFilter).length;
  const items: T[] = [];
  const skippedIndexes: SafeIndexHex[] = [];
  let current = 0;
  onProgress?.(current, total);

  for (const item of listedItems) {
    check();
    try {
      const decoded = await decode(item);
      if (decoded !== undefined) items.push(decoded);
    } catch (error) {
      if (!(error instanceof InvalidCardItemError)) throw error;
      skippedIndexes.push(item.index);
    }
    check();
    if (progressFilter(item)) onProgress?.(++current, total);
  }

  check();
  return {items, skippedIndexes};
}
