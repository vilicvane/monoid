import {MonoidCardError} from '../../@lib/monoid/index.js';
import {isCredentialRequestCancelled} from '../../@services/index.js';
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
  while (!signal?.aborted) {
    try {
      await scan(
        content,
        async (applet, setStateContent, hello, scanSignal) => {
          const result = await callback(
            applet,
            setStateContent,
            hello,
            scanSignal,
          );
          scanned.add(uint8ArrayToHex(hello.publicKey));
          return result;
        },
        hello => {
          if (scanned.has(uint8ArrayToHex(hello.publicKey)))
            throw new MonoidCardError('Card already done, scan another card');
          validate?.(hello);
        },
        signal,
        authentication,
      );
    } catch (error) {
      if (signal?.aborted || isCredentialRequestCancelled(error)) return;
      throw error;
    }
  }
}
