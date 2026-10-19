import type {SafeIndexHex} from '../../../@atomics.js';
import {
  type MonoidApplet,
  type MonoidAppletHello,
  MonoidWrongCardError,
} from '../../../@lib/monoid/index.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../../@utils/index.js';

import type {ScannedCardData} from './common.js';

export function assertCardForUpdate(
  hello: MonoidAppletHello,
  card: Pick<ScannedCardData, 'id' | 'publicKey'>,
): void {
  if (
    uint8ArrayToHex(hello.id) !== card.id ||
    uint8ArrayToHex(hello.publicKey) !== card.publicKey
  ) {
    throw new MonoidWrongCardError(card.id);
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw Object.assign(new Error('Updating card was cancelled.'), {
      code: 'CANCELLED',
    });
  }
}

export async function writeCardAliases(
  applet: MonoidApplet,
  pending: Map<SafeIndexHex, string>,
  signal: AbortSignal,
  onUpdated: (index: SafeIndexHex, alias: string) => void,
): Promise<void> {
  for (const [index, alias] of pending) {
    throwIfCancelled(signal);

    await applet.set({index: hexToUint8Array(index), alias});

    // Record acknowledged writes even if cancellation arrived during the command.
    pending.delete(index);
    onUpdated(index, alias);

    throwIfCancelled(signal);
  }
}
