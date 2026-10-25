import {probeApplet} from '../../../../@lib/applet.js';
import {
  type CardInformation,
  readCardInformation,
} from '../../../../@lib/global-platform/card-information.js';
import {
  type MonoidApplet,
  MonoidAppletHello,
} from '../../../../@lib/monoid/index.js';

export type CardSetupScan =
  | {type: 'ready'; hello: MonoidAppletHello}
  | {type: 'setup'; cardInformation: CardInformation};

/** Read an installed card or collect information for the setup page. */
export async function readCardForSetup(
  sessionId: string,
  monoidApplet: MonoidApplet,
  onStatus: (content: string) => void,
  signal: AbortSignal,
): Promise<CardSetupScan> {
  signal.throwIfAborted();
  const applet = monoidApplet.attachSession(sessionId);
  const installed = await probeApplet(applet, applet.aid);
  signal.throwIfAborted();
  if (!installed) {
    onStatus('Reading card information, hold tight...');
    signal.throwIfAborted();
    const cardInformation = await readCardInformation(sessionId, signal);
    signal.throwIfAborted();

    return {type: 'setup', cardInformation};
  }

  signal.throwIfAborted();
  const hello = await applet.hello({});
  signal.throwIfAborted();

  return {type: 'ready', hello: MonoidAppletHello.satisfies(hello)};
}
