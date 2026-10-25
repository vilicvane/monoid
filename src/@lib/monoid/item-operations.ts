import type {SafeIndex, SafeIndexHex} from '../../@atomics.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../@utils/index.js';
import {InvalidCardItemError} from '../card-item-error.js';
import {
  CBORAppletError,
  CardItemExistsError,
  CardItemNotFoundError,
} from '../cbor-applet.js';
import {equalBytes} from '../global-platform/commands.js';

import {MonoidCardError} from './card-error.js';
import type {MonoidApplet} from './monoid-applet.js';

export type CardItemIssue = {index: string; reason: string};

/** Only definite, item-local failures may be skipped; never transport or PIN errors. */
export function cardItemIssue(
  index: string,
  error: unknown,
): CardItemIssue | undefined {
  if (
    error instanceof CardItemConflictError ||
    error instanceof CardItemExistsError
  )
    return {index, reason: 'Conflict'};
  if (error instanceof InvalidCardItemError)
    return {index, reason: 'Unreadable'};
  if (
    error instanceof CBORAppletError &&
    [
      'INVALID_PARAMETER',
      'NOT_FOUND',
      'UNSUPPORTED_CURVE',
      'UNSUPPORTED_SEED_LENGTH',
    ].includes(error.source.code)
  )
    return {index, reason: error.source.code};
  return undefined;
}

/** Each acknowledged result, including an absent item, completes one index. */
export async function removeItems(
  applet: MonoidApplet,
  pending: Set<SafeIndexHex>,
  signal: AbortSignal,
  onRemoved: (index: SafeIndexHex, removed: boolean) => void = () => {},
): Promise<void> {
  for (const index of pending) {
    signal.throwIfAborted();
    const {removed} = await applet.remove({index: hexToUint8Array(index)});

    // Keep the ACK even if cancellation arrived during the command.
    pending.delete(index);
    onRemoved(index, removed);
    signal.throwIfAborted();
  }
}

export async function setItemAlias(
  applet: MonoidApplet,
  index: SafeIndexHex,
  alias: string,
  notFound: (cause: CardItemNotFoundError) => Error,
): Promise<void> {
  try {
    await applet.set({index: hexToUint8Array(index), alias});
  } catch (error) {
    if (error instanceof CardItemNotFoundError) throw notFound(error);
    throw error;
  }
}

export type CardItemExpectation = {
  index: SafeIndex;
  metadata?: Uint8Array;
  alias?: string;
  secret: boolean;
  /** Plaintext, when available; never an encrypted Import envelope. */
  data?: Uint8Array;
};

export class CardItemConflictError extends MonoidCardError {
  constructor(index: SafeIndex | string) {
    super(
      `Item ${typeof index === 'string' ? index : uint8ArrayToHex(index)}: conflicting item data`,
    );
  }
}

/** View cannot reveal Secret data. Digest-indexed keys already pin that data. */
export async function hasMatchingItem(
  applet: MonoidApplet,
  expected: CardItemExpectation,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  let current: Awaited<ReturnType<MonoidApplet['view']>>;
  try {
    current = await applet.view({index: expected.index});
  } catch (error) {
    if (!(error instanceof CardItemNotFoundError)) throw error;
    signal?.throwIfAborted();
    return false;
  }
  signal?.throwIfAborted();

  if (
    current.alias !== expected.alias ||
    current.secret !== expected.secret ||
    (current.metadata === undefined || expected.metadata === undefined
      ? current.metadata !== expected.metadata
      : !equalBytes(current.metadata, expected.metadata))
  ) {
    throw new CardItemConflictError(expected.index);
  }

  if (!current.secret && expected.data !== undefined) {
    const {data} = await applet.get({index: expected.index});
    signal?.throwIfAborted();
    if (!equalBytes(data, expected.data)) {
      throw new CardItemConflictError(expected.index);
    }
  }

  return true;
}

/** EXISTS is acknowledged only after checking the stored item. Never retry a write. */
export async function acceptMatchingItem(
  applet: MonoidApplet,
  expected: CardItemExpectation,
  error: unknown,
  signal?: AbortSignal,
): Promise<void> {
  if (
    !(error instanceof CardItemExistsError) ||
    !(await hasMatchingItem(applet, expected, signal))
  ) {
    throw error;
  }
}
