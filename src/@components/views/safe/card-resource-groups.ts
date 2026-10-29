import type {ScannedCardItemData} from './common.js';

type CardResourceData = Pick<
  ScannedCardItemData,
  'index' | 'type' | 'derivationRecord' | 'keyDerivationRecord'
>;

export type CardResourceGroup<T> = {
  item: T;
  items: T[];
};

export function getCardResourceGroups<T extends CardResourceData>(
  items: readonly T[],
): CardResourceGroup<T>[] {
  const roots = new Map<string, CardResourceGroup<T>>();

  for (const item of items) {
    if (
      item.type === 'seed' ||
      item.type === 'secp256k1' ||
      item.type === 'ed25519'
    ) {
      roots.set(item.index, {item, items: [item]});
    }
  }

  const groups: CardResourceGroup<T>[] = [];

  for (const item of items) {
    const sourceIndex =
      item.derivationRecord?.index ?? item.keyDerivationRecord?.index;
    const candidate = sourceIndex ? roots.get(sourceIndex) : undefined;
    const source =
      item.keyDerivationRecord && candidate?.item.type !== 'seed'
        ? undefined
        : candidate;

    if (source) {
      source.items.push(item);
    } else {
      groups.push(roots.get(item.index) ?? {item, items: [item]});
    }
  }

  return groups;
}

export function formatCardResourceCount<T>(
  groups: readonly CardResourceGroup<T>[],
  isComplete?: (item: T) => boolean,
): string {
  const attached = groups.flatMap(group => group.items.slice(1));

  if (!isComplete) {
    return attached.length
      ? `${groups.length}+${attached.length}`
      : `${groups.length}`;
  }

  const items = groups.flatMap(group => group.items);

  return `${items.filter(isComplete).length}/${items.length}`;
}
