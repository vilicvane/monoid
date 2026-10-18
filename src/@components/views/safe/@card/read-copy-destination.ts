import {AppletNotFoundError} from '../../../../@lib/applet.js';
import {
  type AppletInstallProgress,
  type MonoidApplet,
  MonoidAppletHelloWithSafe,
  installMonoidApplets,
} from '../../../../@lib/monoid/index.js';

/** Only the first destination scan may install missing applets. */
export async function readCopyDestination(
  sessionId: string,
  monoidApplet: MonoidApplet,
  onProgress: (update: AppletInstallProgress) => void,
  signal: AbortSignal,
): Promise<MonoidAppletHelloWithSafe> {
  signal.throwIfAborted();
  let applet: MonoidApplet;

  try {
    applet = await monoidApplet.openSession(sessionId);
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof AppletNotFoundError)) {
      throw error;
    }

    return installMonoidApplets(sessionId, onProgress, signal);
  }

  signal.throwIfAborted();
  const hello = await applet.hello({safe: true});
  signal.throwIfAborted();

  return MonoidAppletHelloWithSafe.satisfies(hello);
}
