import {IsoDepNfc} from 'capacitor-isodep-nfc';
import {sha256} from 'ethers';

import {hexToUint8Array} from '../../@utils/index.js';
import {exchange} from '../global-platform/commands.js';
import {
  type GlobalPlatformInstallProgress,
  GlobalPlatformInstaller,
} from '../global-platform/install.js';

import {appletBundle} from './@applet-bundle.js';
import {
  MonoidAppletHelloWithSafe,
  createMonoidApplet,
} from './monoid-applet.js';

export type BundledApplet = {
  stage: 'identity' | 'safe' | 'monoid';
  packageAid: string;
  appletAid: string;
  codeURL: URL;
  sha256: string;
};

export type AppletInstallProgress =
  | {stage: 'checking' | 'verifying'}
  | ({
      stage: BundledApplet['stage'];
      phase: Exclude<GlobalPlatformInstallProgress['phase'], 'complete'>;
    } & GlobalPlatformInstallProgress);

export const hasAppletBundle = appletBundle !== undefined;

/** The bundle is loaded and checked before the first card-management command. */
export async function installMonoidApplets(
  sessionId: string,
  onProgress: (update: AppletInstallProgress) => void,
  signal?: AbortSignal,
): Promise<MonoidAppletHelloWithSafe> {
  signal?.throwIfAborted();

  if (!appletBundle) {
    throw new Error('The applet installation package is not available yet.');
  }

  if (
    appletBundle.length !== 3 ||
    appletBundle[0].stage !== 'identity' ||
    appletBundle[1].stage !== 'safe' ||
    appletBundle[2].stage !== 'monoid'
  ) {
    throw new Error('The applet installation package is incomplete.');
  }

  onProgress({stage: 'checking'});
  signal?.throwIfAborted();

  const packages = await Promise.all(
    appletBundle.map(async item => {
      const response = await fetch(item.codeURL, {signal});
      signal?.throwIfAborted();

      if (!response.ok) {
        throw new Error('Could not read the bundled applet package.');
      }

      const code = new Uint8Array(await response.arrayBuffer());
      signal?.throwIfAborted();

      if (sha256(code).slice(2) !== item.sha256) {
        throw new Error(
          'The bundled applet package failed its integrity check.',
        );
      }

      return {
        stage: item.stage,
        packageAid: hexToUint8Array(item.packageAid),
        appletAid: hexToUint8Array(item.appletAid),
        code,
      };
    }),
  );
  signal?.throwIfAborted();

  const installer = await GlobalPlatformInstaller.open(command =>
    exchange(async data => {
      signal?.throwIfAborted();
      const response = await IsoDepNfc.transceive({
        sessionId,
        data: Array.from(data),
        timeoutMs: 30000,
      });
      signal?.throwIfAborted();

      return new Uint8Array(response.data);
    }, command),
  );

  for (const applet of packages) {
    signal?.throwIfAborted();
    await installer.install(applet, update => {
      signal?.throwIfAborted();
      if (update.phase === 'uploading') {
        onProgress({stage: applet.stage, ...update});
      } else if (update.phase !== 'complete') {
        onProgress({stage: applet.stage, phase: update.phase});
      }
      signal?.throwIfAborted();
    });
  }

  signal?.throwIfAborted();
  onProgress({stage: 'verifying'});
  signal?.throwIfAborted();

  // SELECT ends the GP secure channel. This checks availability and the hello
  // schema, not hardware crypto support; features are firmware declarations.
  const monoid = await createMonoidApplet(packages[2].appletAid).openSession(
    sessionId,
  );
  signal?.throwIfAborted();

  const hello = await monoid.hello({safe: true});
  signal?.throwIfAborted();

  return MonoidAppletHelloWithSafe.satisfies(hello);
}
