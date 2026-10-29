import {uint8ArrayToHex} from '../../@utils/index.js';

export type NamedCard = {id: string | Uint8Array; alias?: string | false};

export function cardName({id, alias}: NamedCard): string {
  return alias || (typeof id === 'string' ? id : uint8ArrayToHex(id));
}

/** Scan instructions retain the ID even when the card has an alias. */
export function cardNameWithId(card: NamedCard): string {
  return card.alias
    ? `${card.alias} (${cardName({id: card.id})})`
    : cardName(card);
}
