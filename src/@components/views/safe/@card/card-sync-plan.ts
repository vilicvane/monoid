import {
  type CardBackupIdentity,
  CardItemConflictError,
  type CardItemIssue,
} from '../../../../@lib/monoid/index.js';
import {mergeCardItemData} from '../card-item-merge.js';
import type {ScannedCardItemData} from '../common.js';

export type CardSyncIdentity = CardBackupIdentity;

export type CardSyncExport = {metadata?: string; alias?: string; data: string};

export type CardSyncItem = ScannedCardItemData & {
  /** Plaintext is retained only for items which Get permits reading. */
  data?: string;
  exported?: CardSyncExport;
};

export type CardSyncSnapshot = CardSyncIdentity & {
  items: CardSyncItem[];
  issues?: CardItemIssue[];
};

export type CardSyncOperation = {
  kind: 'create' | 'import' | 'data' | 'alias';
  before?: CardSyncItem;
  after: CardSyncItem;
  exported?: CardSyncExport;
};

export type CardSyncPlan = {
  card: CardSyncSnapshot;
  items: CardSyncItem[];
  operations: CardSyncOperation[];
  issues: CardItemIssue[];
};

function scope(card: CardSyncSnapshot, item: CardSyncItem): string {
  // Only a decoded association inherits its root's scope. All other records
  // stay opaque; arbitrary metadata is never interpreted as a key reference.
  const root =
    card.items.find(
      source =>
        source.index ===
        (item.derivationRecord?.index ?? item.keyDerivationRecord?.index),
    ) ?? item;

  return root.secret
    ? card.bundle === false
      ? `card:${card.publicKey}`
      : `bundle:${card.bundle}`
    : 'public';
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
      left.type === right.type &&
      left.metadata === right.metadata &&
      left.secret === right.secret &&
      left.alias === right.alias &&
      left.data === right.data)
  );
}

/** Collection order chooses nonempty aliases; conflicts exclude only that index. */
export function createCardSyncPlans(
  cards: readonly CardSyncSnapshot[],
): CardSyncPlan[] {
  const merged = new Map<
    string,
    {
      scope: string;
      item: CardSyncItem;
      issue?: CardItemIssue;
    }
  >();

  for (const card of cards) {
    const indexes = new Set<string>();

    for (const item of card.items) {
      const itemScope = scope(card, item);
      const key = `${itemScope}:${item.index}`;
      const issue = card.issues?.find(issue => issue.index === item.index);
      const previous = merged.get(key);

      if (!previous) {
        merged.set(key, {scope: itemScope, item: {...item}, issue});
      } else if (previous.issue || issue) {
        previous.issue ??= issue;
      } else {
        try {
          if (indexes.has(item.index))
            throw new CardItemConflictError(item.index);
          previous.item = mergeCardItemData(previous.item, item);
          if (!previous.item.alias?.trim() && item.alias?.trim())
            previous.item.alias = item.alias;
        } catch (error) {
          if (!(error instanceof CardItemConflictError)) throw error;
          previous.issue = {index: item.index, reason: 'Conflict'};
        }
      }
      indexes.add(item.index);
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
          Number(
            !!(left.item.derivationRecord ?? left.item.keyDerivationRecord),
          ) -
          Number(
            !!(right.item.derivationRecord ?? right.item.keyDerivationRecord),
          ),
      );
    const operations: CardSyncOperation[] = [];
    const issues = new Map(
      (card.issues ?? []).map(issue => [issue.index, issue]),
    );
    const items: CardSyncItem[] = [];

    for (const {item: desired, issue} of relevant) {
      if (
        relevant.some(
          entry => entry.item.index === desired.index && entry.item !== desired,
        )
      ) {
        issues.set(desired.index, {index: desired.index, reason: 'Conflict'});
        continue;
      }
      if (issue) {
        issues.set(issue.index, issue);
        continue;
      }
      let current = card.items.find(item => item.index === desired.index);
      if (!current) {
        if (desired.secret) {
          if (!desired.exported) {
            issues.set(desired.index, {
              index: desired.index,
              reason: 'Not exported',
            });
            continue;
          }
          const {alias, metadata} = desired.exported;
          current = {...desired, alias, metadata};
          operations.push({
            kind: 'import',
            after: current,
            exported: desired.exported,
          });
        } else {
          if (desired.data === undefined) {
            issues.set(desired.index, {
              index: desired.index,
              reason: 'Unreadable',
            });
            continue;
          }
          operations.push({kind: 'create', after: desired});
          current = desired;
        }
      } else if (!desired.secret && current.data !== desired.data) {
        const after = {
          ...current,
          data: desired.data,
          derivationRecord: desired.derivationRecord,
          keyDerivationRecord: desired.keyDerivationRecord,
        };
        operations.push({kind: 'data', before: current, after});
        current = after;
      }

      if (desired.alias?.trim() && current.alias !== desired.alias) {
        operations.push({
          kind: 'alias',
          before: current,
          after: {...current, alias: desired.alias},
        });
      }
      items.push(desired);
    }

    return {card, items, operations, issues: [...issues.values()]};
  });
}
