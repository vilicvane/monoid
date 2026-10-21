import {MonoidCardError} from '../../../../@lib/monoid/index.js';
import {uint8ArrayToHex} from '../../../../@utils/index.js';
import {
  encodeCardDerivationRecord,
  isCardDerivationItem,
  mergeCardDerivationWallets,
} from '../card-derivations.js';
import type {ScannedCardItemData} from '../common.js';

export type CardSyncIdentity = {
  id: string;
  publicKey: string;
  bundle: string | false;
};

export type CardSyncExport = {key?: string; alias?: string; data: string};

export type CardSyncItem = ScannedCardItemData & {
  /** Plaintext is retained only for items which Get permits reading. */
  data?: string;
  /** Full public key and, for a seed, its BIP32 root chain code. */
  fingerprint?: string;
  exported?: CardSyncExport;
};

export type CardSyncSnapshot = CardSyncIdentity & {items: CardSyncItem[]};

export type CardSyncOperation = {
  kind: 'create' | 'import' | 'verify' | 'data' | 'alias';
  before?: CardSyncItem;
  after: CardSyncItem;
  exported?: CardSyncExport;
};

export type CardSyncPlan = {
  card: CardSyncSnapshot;
  items: CardSyncItem[];
  operations: CardSyncOperation[];
};

function fail(index: string, reason: string): never {
  throw new MonoidCardError(`Item ${index}: ${reason}`);
}

function association(item: CardSyncItem): string | undefined {
  return item.derivationRecord?.index;
}

function scope(card: CardSyncSnapshot, item: CardSyncItem): string {
  let root = item;

  if (isCardDerivationItem(item)) {
    if (!item.derivationRecord) fail(item.index, 'invalid address records');
    const source = card.items.find(
      candidate => candidate.index === item.derivationRecord!.index,
    );

    if (!source) fail(item.index, 'associated key is missing');
    root = source;
  }

  return root.secret
    ? card.bundle === false
      ? `card:${card.publicKey}`
      : `bundle:${card.bundle}`
    : 'public';
}

function sameStructure(left: CardSyncItem, right: CardSyncItem): boolean {
  return (
    left.key === right.key &&
    left.secret === right.secret &&
    association(left) === association(right)
  );
}

/** Compare observations, excluding ciphertext and display-only address previews. */
export function sameCardSyncItem(
  left: CardSyncItem | undefined,
  right: CardSyncItem | undefined,
): boolean {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.index === right.index &&
      sameStructure(left, right) &&
      left.alias === right.alias &&
      left.data === right.data &&
      left.fingerprint === right.fingerprint)
  );
}

/** Pure, stable plan: collection order chooses opaque values and nonempty aliases. */
export function createCardSyncPlans(
  cards: readonly CardSyncSnapshot[],
): CardSyncPlan[] {
  const shapes = new Map<string, CardSyncItem>();
  const merged = new Map<
    string,
    {
      scope: string;
      item: CardSyncItem;
      sources: {publicKey: string; item: CardSyncItem}[];
    }
  >();

  for (const card of cards) {
    const indexes = new Set<string>();

    for (const item of card.items) {
      if (indexes.has(item.index)) fail(item.index, 'duplicate item');
      indexes.add(item.index);
      const itemScope = scope(card, item);
      const key = `${itemScope}:${item.index}`;
      const shape = shapes.get(key);

      if (shape && !sameStructure(shape, item)) {
        fail(item.index, 'conflicting item metadata');
      }

      shapes.set(key, item);
      const previous = merged.get(key);

      if (!previous) {
        merged.set(key, {
          scope: itemScope,
          item: {...item},
          sources: [{publicKey: card.publicKey, item}],
        });
        continue;
      }

      const first = previous.item;

      if (item.secret) {
        if (!first.fingerprint && !item.fingerprint) {
          if (first.alias !== item.alias) {
            fail(
              item.index,
              'cannot compare Secret data with different aliases',
            );
          }
        } else if (first.fingerprint !== item.fingerprint) {
          fail(item.index, 'conflicting Secret data');
        }
      }

      previous.sources.push({publicKey: card.publicKey, item});

      if (!first.alias?.trim() && item.alias?.trim()) {
        first.alias = item.alias;
      }

      if (first.derivationRecord && item.derivationRecord) {
        first.derivationRecord = {
          index: first.derivationRecord.index,
          wallets: mergeCardDerivationWallets(
            first.derivationRecord.wallets,
            item.derivationRecord.wallets,
          ),
        };
        first.data = uint8ArrayToHex(
          encodeCardDerivationRecord(first.derivationRecord),
        );
      }
    }
  }

  return cards.map(card => {
    const relevant = [...merged.values()]
      .filter(
        entry =>
          entry.scope === 'public' ||
          entry.scope === `card:${card.publicKey}` ||
          (card.bundle !== false && entry.scope === `bundle:${card.bundle}`),
      )
      .sort(
        (left, right) =>
          Number(!!left.item.derivationRecord) -
          Number(!!right.item.derivationRecord),
      );
    const operations: CardSyncOperation[] = [];
    const targetIndexes = new Set<string>();

    for (const {item: desired, sources} of relevant) {
      if (targetIndexes.has(desired.index)) {
        fail(desired.index, 'conflicting sync scopes');
      }
      targetIndexes.add(desired.index);
      let current = card.items.find(item => item.index === desired.index);

      if (current?.secret && !current.fingerprint && sources.length > 1) {
        const other = sources.find(
          source => source.publicKey !== card.publicKey,
        );
        if (!other?.item.exported)
          fail(desired.index, 'Secret data was not exported');
        operations.push({
          kind: 'verify',
          before: current,
          after: current,
          exported: other.item.exported,
        });
      }

      if (!current) {
        if (desired.secret) {
          if (!desired.exported)
            fail(desired.index, 'Secret data was not exported');
          const {alias, key} = desired.exported;
          const imported = {...desired, alias, key};
          operations.push({
            kind: 'import',
            after: imported,
            exported: desired.exported,
          });
          current = imported;
        } else {
          if (desired.data === undefined)
            fail(desired.index, 'data was not read');
          operations.push({kind: 'create', after: desired});
          current = desired;
        }
      } else if (!desired.secret && current.data !== desired.data) {
        const after = {
          ...current,
          data: desired.data,
          derivationRecord: desired.derivationRecord,
        };
        operations.push({kind: 'data', before: current, after});
        current = after;
      }

      // Empty aliases never replace a name, including an empty first card.
      if (desired.alias?.trim() && current.alias !== desired.alias) {
        operations.push({
          kind: 'alias',
          before: current,
          after: {...current, alias: desired.alias},
        });
      }
    }

    // Verify opaque copies before any writes; the stable sort preserves the
    // root-before-companion order of all remaining operations.
    operations.sort(
      (left, right) =>
        Number(right.kind === 'verify') - Number(left.kind === 'verify'),
    );

    return {card, items: relevant.map(entry => entry.item), operations};
  });
}
