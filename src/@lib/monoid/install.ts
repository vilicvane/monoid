import {IsoDepNfc} from 'capacitor-isodep-nfc';

import {hexToUint8Array, uint8ArrayToHex} from '../../@utils/index.js';
import {exchange} from '../global-platform/commands.js';
import {GlobalPlatformInstaller} from '../global-platform/install.js';

import {appletBundle} from './@applet-bundle.js';
import {type MonoidApplet, createMonoidApplet} from './monoid-applet.js';

export type BundledApplet = {
  stage: 'safe' | 'monoid';
  packageAid: string;
  appletAid: string;
  codeURL: URL;
  sha256: string;
};

export type AppletInstallProgress = {
  stage: 'checking' | 'safe' | 'monoid' | 'verifying';
  progress?: number;
};

export const hasAppletBundle = appletBundle !== undefined;

/** The bundled pair is loaded and checked before the first card-management command. */
export async function installMonoidApplets(
  sessionId: string,
  onProgress: (update: AppletInstallProgress) => void,
): Promise<Awaited<ReturnType<MonoidApplet['hello']>>> {
  if (!appletBundle) {
    throw new Error('The applet installation package is not available yet.');
  }

  if (
    appletBundle.length !== 2 ||
    appletBundle[0].stage !== 'safe' ||
    appletBundle[1].stage !== 'monoid'
  ) {
    throw new Error('The applet installation package is incomplete.');
  }

  onProgress({stage: 'checking'});

  const packages = await Promise.all(
    appletBundle.map(async item => {
      const response = await fetch(item.codeURL);

      if (!response.ok) {
        throw new Error('Could not read the bundled applet package.');
      }

      const code = new Uint8Array(await response.arrayBuffer());
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', code),
      );

      if (uint8ArrayToHex(digest) !== item.sha256) {
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

  const installer = await GlobalPlatformInstaller.open(command =>
    exchange(async data => {
      const response = await IsoDepNfc.transceive({
        sessionId,
        data: Array.from(data),
        timeoutMs: 30000,
      });

      return new Uint8Array(response.data);
    }, command),
  );

  for (const applet of packages) {
    await installer.install(applet, progress =>
      onProgress({stage: applet.stage, progress}),
    );
  }

  onProgress({stage: 'verifying'});

  // SELECT ends the GP secure channel. Verify the installed applet using its real schema.
  const monoid = await createMonoidApplet(packages[1].appletAid).openSession(
    sessionId,
  );

  return monoid.hello({});
}
