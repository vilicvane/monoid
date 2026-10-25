import {MultiCardSeries} from '../../@lib/monoid/index.js';
import {isOperationCancelled} from '../../@lib/operation-cancelled.js';
import {uint8ArrayToHex} from '../../@utils/index.js';

import type {
  MonoidScanAuthentication,
  MonoidScanPrompt,
  MonoidScanPromptCallback,
  MonoidScanPromptValidateCard,
} from './monoid-scan-prompt.js';

/**
 * Repeats a completed card operation on further cards until the prompt is
 * dismissed. `scanned` holds the public keys of finished cards. A failure ends
 * the series; the operations tolerate repetition, so it can simply be restarted.
 */
export async function scanNextCards({
  scan,
  scanned,
  content,
  callback,
  validate,
  signal,
  authentication,
}: {
  scan: MonoidScanPrompt;
  scanned: Set<string>;
  content: string;
  callback: MonoidScanPromptCallback;
  validate?: MonoidScanPromptValidateCard;
  signal?: AbortSignal;
  authentication?: MonoidScanAuthentication;
}): Promise<void> {
  const series = new MultiCardSeries(scanned);

  while (!signal?.aborted) {
    try {
      await scan(
        content,
        (applet, setStateContent, hello, scanSignal) =>
          series.run(uint8ArrayToHex(hello.publicKey), () =>
            callback(applet, setStateContent, hello, scanSignal),
          ),
        hello => {
          series.assertPending(uint8ArrayToHex(hello.publicKey));
          validate?.(hello);
        },
        signal,
        authentication,
      );
    } catch (error) {
      if (isOperationCancelled(error, signal)) return;
      throw error;
    }
  }
}
