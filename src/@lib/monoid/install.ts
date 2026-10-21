import {IsoDepNfc} from 'capacitor-isodep-nfc';
import {sha256, toUtf8Bytes} from 'ethers';

import {hexToUint8Array, uint8ArrayToHex} from '../../@utils/index.js';
import {AppletISOError, AppletNotFoundError} from '../applet.js';
import {
  type CardInformation,
  readCardInformation,
} from '../global-platform/card-information.js';
import {
  exchange,
  parseResponse,
  shortCommand,
} from '../global-platform/commands.js';
import {
  type AppletPackage,
  type GlobalPlatformInstallProgress,
  GlobalPlatformInstaller,
} from '../global-platform/install.js';

import {appletBundle} from './@applet-bundle.js';
import {MonoidCardError} from './card-error.js';
import {MonoidAppletHello, createMonoidApplet} from './monoid-applet.js';

export type BundledApplet = {
  stage: 'identity' | 'monoid';
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

export type AppletReplacementCheckpoint =
  | 'remove-monoid-instance'
  | 'remove-monoid-package'
  | 'remove-identity-instance'
  | 'remove-identity-package'
  | 'install'
  | 'verify';

export type AppletReplacementProgress = {
  stage: 'deleting';
  applet: BundledApplet['stage'];
};

export type MonoidAppletInstallation = {
  identity: InstalledApplet;
  monoid: InstalledApplet;
  hello?: MonoidAppletHello;
  helloError?: unknown;
  registryError?: unknown;
};

export type InstalledApplet = {
  installed: boolean | undefined;
  /** Exact instance AID observed in the registry, never inferred from a prefix SELECT. */
  aid?: string;
  loaded?: boolean;
  lifecycle?: number;
  /** GP package version is not the Monoid firmware version or a code fingerprint. */
  packageVersion?: {major: number; minor: number};
  version?: number;
};

type LoadedApplet = AppletPackage & {stage: BundledApplet['stage']};

export function getMonoidAppletBundleHashes(): string[] {
  return appletBundle?.map(item => item.sha256) ?? [];
}

export function getBundledMonoidAppletAid(): string {
  if (!appletBundle?.[1])
    throw new Error('The applet installation package is incomplete');
  return appletBundle[1].appletAid;
}

export function getCardMaintenanceFingerprint(
  information: CardInformation,
): string {
  if (!information.cplc) {
    throw new Error('Card production information is required for maintenance');
  }
  return sha256(
    toUtf8Bytes(
      JSON.stringify([
        information.cardManagerAid,
        information.cplc.icFabricator,
        information.cplc.icType,
        information.cplc.operatingSystemId,
        information.cplc.operatingSystemReleaseDate,
        information.cplc.operatingSystemReleaseLevel,
        information.cplc.icSerialNumber,
      ]),
    ),
  );
}

/** Public registry failure is reported separately from observed applet presence. */
export async function readMonoidAppletInstallation(
  sessionId: string,
  signal?: AbortSignal,
): Promise<MonoidAppletInstallation> {
  const result: MonoidAppletInstallation = {
    identity: {installed: undefined},
    monoid: {installed: undefined},
  };
  const transceive = cardTransceive(sessionId, signal);
  const aids = [
    {
      stage: 'identity' as const,
      packageAid: hexToUint8Array('f06d6f6e6f696400'),
      appletAid: hexToUint8Array('f06d6f6e6f69640001'),
    },
    {
      stage: 'monoid' as const,
      packageAid: hexToUint8Array('f06d6f6e6f696402'),
      appletAid: hexToUint8Array('f06d6f6e6f69640201'),
    },
  ];

  try {
    const registry = await GlobalPlatformInstaller.inspect(transceive);
    for (const {stage, appletAid, packageAid} of aids) {
      const instance = await registry.getEntry(0x40, appletAid);
      const loaded = await registry.getEntry(0x10, packageAid);
      result[stage] = {
        installed: !!instance,
        aid: instance && uint8ArrayToHex(instance.aid),
        loaded: !!loaded,
        lifecycle: instance?.lifecycle,
        packageVersion: loaded?.version,
      };
    }
  } catch (error) {
    signal?.throwIfAborted();
    rethrowConnectionError(error);
    result.registryError = error;
  }

  if (result.identity.installed === undefined) {
    const response = await transceive(
      shortCommand(0xa4, 4, 0, aids[0].appletAid, 0),
    );
    const {sw} = parseResponse(response);
    if (sw === 0x9000) result.identity.installed = true;
    if (sw === 0x6a82) result.identity.installed = false;
  }

  try {
    const monoid = await createMonoidApplet(aids[1].appletAid).openSession(
      sessionId,
    );
    signal?.throwIfAborted();
    result.monoid.installed = true;
    result.hello = await monoid.hello({});
    result.monoid.version = result.hello.version;
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    rethrowConnectionError(error);
    if (error instanceof AppletNotFoundError && !result.monoid.installed) {
      result.monoid.installed = false;
    } else {
      result.helloError = error;
    }
  }
  return result;
}

/** Resolve the exact instance before maintenance; a prefix SELECT is insufficient. */
export async function resolveMonoidAppletMaintenanceAid(
  sessionId: string,
  installation: MonoidAppletInstallation,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (installation.monoid.aid) return installation.monoid.aid;

  const {registryError} = installation;
  if (
    !(registryError instanceof AppletISOError && registryError.sw === 0x6982)
  ) {
    throw (
      registryError ?? new MonoidCardError('Could not identify Monoid Applet')
    );
  }

  // Some cards expose SELECT/Hello but require GP authentication for GET STATUS.
  // Only an explicitly requested maintenance operation opens this channel.
  const registry = await GlobalPlatformInstaller.open(
    cardTransceive(sessionId, signal),
  );
  signal?.throwIfAborted();
  const instance = await registry.getEntry(
    0x40,
    hexToUint8Array(getBundledMonoidAppletAid()),
  );
  signal?.throwIfAborted();
  if (!instance) throw new MonoidCardError('Could not identify Monoid Applet');
  return uint8ArrayToHex(instance.aid);
}

function rethrowConnectionError(error: unknown): void {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    [
      'NFC_DISABLED',
      'APP_INACTIVE',
      'SCAN_CLOSED',
      'SESSION_CLOSED',
      'CANCELLED',
      'TIMEOUT',
      'TAG_LOST',
      'IO_ERROR',
    ].includes(String(error.code))
  ) {
    throw error;
  }
}

/** Validate load images before opening a management session or deleting anything. */
async function loadAppletPackages(
  signal?: AbortSignal,
): Promise<LoadedApplet[]> {
  signal?.throwIfAborted();

  if (!appletBundle) {
    throw new Error('The applet installation package is not available yet.');
  }

  if (
    appletBundle.length !== 2 ||
    appletBundle[0].stage !== 'identity' ||
    appletBundle[1].stage !== 'monoid'
  ) {
    throw new Error('The applet installation package is incomplete.');
  }

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
  return packages;
}

function cardTransceive(
  sessionId: string,
  signal?: AbortSignal,
): (command: Uint8Array) => Promise<Uint8Array> {
  return command =>
    exchange(async data => {
      signal?.throwIfAborted();
      const response = await IsoDepNfc.transceive({
        sessionId,
        data: Array.from(data),
        timeoutMs: 30000,
      });
      signal?.throwIfAborted();

      return new Uint8Array(response.data);
    }, command);
}

async function installPackages(
  installer: GlobalPlatformInstaller,
  packages: LoadedApplet[],
  onProgress: (update: AppletInstallProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
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
}

async function verifyInstallation(
  sessionId: string,
  appletAid: Uint8Array,
  onProgress: (update: AppletInstallProgress) => void,
  signal?: AbortSignal,
): Promise<MonoidAppletHello> {
  signal?.throwIfAborted();
  onProgress({stage: 'verifying'});
  signal?.throwIfAborted();

  // SELECT ends the GP secure channel. This checks availability and the hello
  // schema, not hardware crypto support.
  const monoid = await createMonoidApplet(appletAid).openSession(sessionId);
  signal?.throwIfAborted();

  const hello = await monoid.hello({});
  signal?.throwIfAborted();

  return MonoidAppletHello.satisfies(hello);
}

/** The bundle is loaded and checked before the first card-management command. */
export async function installMonoidApplets(
  sessionId: string,
  onProgress: (update: AppletInstallProgress) => void,
  signal?: AbortSignal,
): Promise<MonoidAppletHello> {
  signal?.throwIfAborted();
  onProgress({stage: 'checking'});
  const packages = await loadAppletPackages(signal);
  const installer = await GlobalPlatformInstaller.open(
    cardTransceive(sessionId, signal),
  );
  await installPackages(installer, packages, onProgress, signal);
  return verifyInstallation(
    sessionId,
    packages[1].appletAid,
    onProgress,
    signal,
  );
}

/**
 * Deletes exact instances/packages only. The owner must persist each checkpoint
 * and the complete encrypted archive before allowing this operation to start.
 */
export async function replaceMonoidApplets(
  sessionId: string,
  {
    fresh,
    checkpoint,
    expectedPublicKey,
    expectedAppletAid,
    expectedBundle,
    expectedFingerprint,
    onCheckpoint,
    onProgress = () => {},
    signal,
  }: {
    fresh: boolean;
    checkpoint?: AppletReplacementCheckpoint;
    expectedPublicKey?: string;
    expectedAppletAid?: string;
    expectedBundle?: string | false;
    expectedFingerprint: string;
    onCheckpoint: (checkpoint: AppletReplacementCheckpoint) => Promise<void>;
    onProgress?: (
      update: AppletInstallProgress | AppletReplacementProgress,
    ) => void;
    signal?: AbortSignal;
  },
): Promise<MonoidAppletHello> {
  signal?.throwIfAborted();
  onProgress({stage: 'checking'});
  const packages = await loadAppletPackages(signal);
  const [identity, monoid] = packages;
  if (!fresh && uint8ArrayToHex(monoid.appletAid) !== expectedAppletAid) {
    throw new Error('The applet identity changed in this installation package');
  }
  const information = await readCardInformation(sessionId, signal);
  if (getCardMaintenanceFingerprint(information) !== expectedFingerprint) {
    throw new Error('Wrong card');
  }
  const steps: AppletReplacementCheckpoint[] = [
    'remove-monoid-instance',
    'remove-monoid-package',
    ...(fresh
      ? (['remove-identity-instance', 'remove-identity-package'] as const)
      : []),
    'install',
    'verify',
  ];
  const position = checkpoint ? steps.indexOf(checkpoint) : 0;
  if (position < 0) throw new Error('Invalid card maintenance checkpoint');

  // A retained Monoid must authenticate the exact Identity before deletion.
  // If an acknowledged/uncertain previous DELETE removed it, only the saved
  // continuation can proceed without Hello; restoration checks Identity again.
  if (!fresh && position === 0) {
    try {
      const applet = await createMonoidApplet(monoid.appletAid).openSession(
        sessionId,
      );
      const hello = await applet.hello({});
      if (
        !expectedPublicKey ||
        uint8ArrayToHex(hello.publicKey) !== expectedPublicKey
      ) {
        throw new Error('Wrong card');
      }
      if (
        (hello.bundle ? uint8ArrayToHex(hello.bundle) : false) !==
        expectedBundle
      ) {
        throw new Error('The card Bundle changed during maintenance');
      }
    } catch (error) {
      if (!(checkpoint && error instanceof AppletNotFoundError)) throw error;
    }
  }
  signal?.throwIfAborted();

  if (steps[position] !== 'verify') {
    const installer = await GlobalPlatformInstaller.open(
      cardTransceive(sessionId, signal),
    );
    if (!fresh && !(await installer.getEntry(0x40, identity.appletAid))) {
      throw new Error('The original Monoid Identity Applet is missing');
    }
    for (const step of steps.slice(position)) {
      signal?.throwIfAborted();
      await onCheckpoint(step);
      signal?.throwIfAborted();
      if (step === 'verify') break;
      if (step === 'install') {
        const installing = fresh ? packages : [monoid];
        for (const applet of installing) {
          const instance = await installer.getEntry(0x40, applet.appletAid);
          const loaded = await installer.getEntry(0x10, applet.packageAid);
          // An interrupted LOAD has no instance or item data. Discard only that
          // exact unfinished code package before an explicitly requested retry.
          if (
            !instance &&
            loaded &&
            (loaded.lifecycle !== 1 ||
              !loaded.modules.some(
                aid =>
                  uint8ArrayToHex(aid) === uint8ArrayToHex(applet.appletAid),
              ))
          ) {
            await installer.removePackage(applet.packageAid);
          }
          await installPackages(installer, [applet], onProgress, signal);
        }
      } else {
        const applet = step.includes('identity') ? identity : monoid;
        onProgress({stage: 'deleting', applet: applet.stage});
        if (step.endsWith('instance')) {
          await installer.removeInstance(applet.appletAid);
        } else {
          await installer.removePackage(applet.packageAid);
        }
      }
    }
  }

  const hello = await verifyInstallation(
    sessionId,
    monoid.appletAid,
    onProgress,
    signal,
  );
  if (!fresh && uint8ArrayToHex(hello.publicKey) !== expectedPublicKey) {
    throw new Error('Card identity changed during maintenance');
  }
  if (
    !fresh &&
    (hello.bundle ? uint8ArrayToHex(hello.bundle) : false) !== expectedBundle
  ) {
    throw new Error('The card Bundle changed during maintenance');
  }
  return hello;
}
