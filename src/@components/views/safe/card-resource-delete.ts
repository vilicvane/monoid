import type {SafeIndexHex} from '../../../@atomics.js';
import {CBORAppletError} from '../../../@lib/cbor-applet.js';
import type {MonoidApplet} from '../../../@lib/monoid/index.js';
import {hexToUint8Array} from '../../../@utils/index.js';

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw Object.assign(new Error('Deleting card items was cancelled.'), {
      code: 'CANCELLED',
    });
  }
}

export async function deleteCardResources(
  applet: MonoidApplet,
  pending: Set<SafeIndexHex>,
  signal: AbortSignal,
  onDeleted: (index: SafeIndexHex) => void,
): Promise<void> {
  for (const index of pending) {
    throwIfCancelled(signal);

    try {
      await applet.remove({index: hexToUint8Array(index)});
    } catch (error) {
      if (
        !(error instanceof CBORAppletError) ||
        error.source.code !== 'NOT_FOUND'
      ) {
        throw error;
      }
    }

    // Record completed deletions even if cancellation arrived during the command.
    pending.delete(index);
    onDeleted(index);

    throwIfCancelled(signal);
  }
}
