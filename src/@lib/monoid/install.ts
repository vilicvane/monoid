import {p256} from '@noble/curves/nist';
import {IsoDepNfc} from 'capacitor-isodep-nfc';
import {sha256, toUtf8Bytes} from 'ethers';

import type {MonoidIdHex, PublicKeyHex} from '../../@atomics.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../@utils/index.js';
import {AppletISOError, AppletNotFoundError, probeApplet} from '../applet.js';
import {
  type CardInformation,
  readCardInformation,
} from '../global-platform/card-information.js';
import {exchange} from '../global-platform/commands.js';
import {
  type AppletPackage,
  type GlobalPlatformInstallProgress,
  GlobalPlatformInstaller,
} from '../global-platform/install.js';

import {appletBundle} from './@applet-bundle.js';
import {MonoidCardError} from './card-error.js';
import {assertSameCardWithBundle} from './card-identity.js';
import {MonoidAppletHello, createMonoidApplet} from './monoid-applet.js';

export type BundledApplet = {
  stage: 'identity' | 'library' | 'monoid' | 'security-key' | 'otp';
  packageAid: string;
  appletAid?: string;
  instanceAid?: string;
  optional?: boolean;
  dependencies?: readonly BundledApplet['stage'][];
  codeURL: URL;
  sha256: string;
};

export type AppletStage = BundledApplet['stage'];

export type AppletInstallProgress =
  | {stage: 'checking' | 'verifying'}
  | ({
      stage: BundledApplet['stage'];
      phase: Exclude<GlobalPlatformInstallProgress['phase'], 'complete'>;
    } & GlobalPlatformInstallProgress);

export const hasAppletBundle = appletBundle !== undefined;

export type AppletReplacementCheckpoint =
  | `remove-${AppletStage}-instance`
  | `remove-${AppletStage}-package`
  | 'install'
  | 'verify';

export type AppletReplacementProgress = {
  stage: 'deleting';
  applet: BundledApplet['stage'];
  completed: number;
  total: number;
};

export type MonoidAppletInstallation = {
  identity: InstalledApplet;
  library: InstalledApplet;
  monoid: InstalledApplet;
  optional: Partial<Record<AppletStage, InstalledApplet>>;
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

export type IdentityInstallationOptions = {
  cardId?: Uint8Array;
  authorityPublicKey?: Uint8Array;
  authorityUrl?: string;
};

function identityApplicationData({
  cardId,
  authorityPublicKey,
  authorityUrl,
}: IdentityInstallationOptions): Uint8Array | undefined {
  if (cardId !== undefined && cardId.length !== 4)
    throw new MonoidCardError('Invalid Card ID');
  if (authorityPublicKey === undefined && authorityUrl === undefined)
    return cardId ? new Uint8Array([0x01, ...cardId]) : undefined;
  if (!authorityPublicKey || !authorityUrl)
    throw new MonoidCardError(
      'Authority URL and public key are required together',
    );
  if (authorityPublicKey.length !== 65 || authorityPublicKey[0] !== 4)
    throw new MonoidCardError('Invalid authority public key');
  try {
    p256.Point.fromHex(authorityPublicKey).assertValidity();
  } catch {
    throw new MonoidCardError('Invalid authority public key');
  }
  let url: URL;
  try {
    url = new URL(authorityUrl);
  } catch {
    throw new MonoidCardError('Invalid authority URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new MonoidCardError('Invalid authority URL');
  const encodedUrl = new TextEncoder().encode(authorityUrl);
  // 247-byte secure INSTALL data minus 35 bytes of GP/AID fields and 66 bytes
  // of flags + key leaves 146 bytes for the URL, or 142 with a retained Card ID.
  if (encodedUrl.length > 146 - (cardId?.length ?? 0))
    throw new MonoidCardError('Authority URL is too long');
  return new Uint8Array([
    cardId ? 0x03 : 0x02,
    ...(cardId ?? []),
    ...authorityPublicKey,
    ...encodedUrl,
  ]);
}

export function getAppletCatalog(): readonly BundledApplet[] {
  return appletBundle ?? [];
}

/** Resolve dependencies once, keeping the catalog order among independent items. */
export function getAppletInstallationPlan(
  selectedOptionalStages: readonly AppletStage[] = [],
): readonly BundledApplet[] {
  const catalog = getAppletCatalog();
  const byStage = new Map(catalog.map(item => [item.stage, item]));
  if (
    byStage.size !== catalog.length ||
    !byStage.get('identity')?.appletAid ||
    !byStage.has('library') ||
    byStage.get('library')!.appletAid !== undefined ||
    !byStage.get('monoid')?.appletAid ||
    ['identity', 'library', 'monoid'].some(
      stage => byStage.get(stage as AppletStage)?.optional,
    )
  ) {
    throw new Error('The applet installation package is incomplete');
  }
  for (const stage of selectedOptionalStages) {
    if (!byStage.get(stage)?.optional) {
      throw new MonoidCardError('Unknown optional applet');
    }
  }
  const result: BundledApplet[] = [];
  const visiting = new Set<AppletStage>();
  const added = new Set<AppletStage>();
  const visit = (stage: AppletStage): void => {
    if (added.has(stage)) return;
    const item = byStage.get(stage);
    if (!item) throw new MonoidCardError('Unknown applet dependency');
    if (visiting.has(stage))
      throw new MonoidCardError('Circular applet dependency');
    visiting.add(stage);
    for (const dependency of item.dependencies ?? []) visit(dependency);
    visiting.delete(stage);
    added.add(stage);
    result.push(item);
  };
  for (const item of catalog) {
    if (!item.optional || selectedOptionalStages.includes(item.stage)) {
      visit(item.stage);
    }
  }
  return result;
}

/** All catalog packages whose imports transitively depend on the changed stages. */
export function getAppletDependents(
  stages: readonly AppletStage[],
): readonly BundledApplet[] {
  const catalog = getAppletCatalog();
  const affected = new Set(stages);
  let changed: boolean;
  do {
    changed = false;
    for (const item of catalog) {
      if (
        !affected.has(item.stage) &&
        item.dependencies?.some(stage => affected.has(stage))
      ) {
        affected.add(item.stage);
        changed = true;
      }
    }
  } while (changed);
  return catalog.filter(
    item => affected.has(item.stage) && !stages.includes(item.stage),
  );
}

export function getMonoidAppletBundleHashes(): string[] {
  return appletBundle?.map(item => item.sha256) ?? [];
}

export function getMonoidAppletBundleHash(
  stage: BundledApplet['stage'],
): string | undefined {
  return appletBundle?.find(item => item.stage === stage)?.sha256;
}

export function getBundledMonoidAppletAid(): string {
  const aid = appletBundle?.find(item => item.stage === 'monoid')?.appletAid;
  if (!aid) throw new Error('The applet installation package is incomplete');
  return aid;
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
  {authenticateRegistry = false}: {authenticateRegistry?: boolean} = {},
): Promise<MonoidAppletInstallation> {
  const result: MonoidAppletInstallation = {
    identity: {installed: undefined},
    library: {installed: undefined},
    monoid: {installed: undefined},
    optional: Object.fromEntries(
      getAppletCatalog()
        .filter(item => item.optional)
        .map(item => [item.stage, {installed: undefined}]),
    ),
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

  const readRegistry = async (
    registry: Pick<GlobalPlatformInstaller, 'getEntry'>,
  ): Promise<void> => {
    signal?.throwIfAborted();
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
    const library = await registry.getEntry(
      0x10,
      hexToUint8Array('f06d6f6e6f696404'),
    );
    result.library = {
      installed:
        !!library && library.lifecycle === 1 && library.modules.length === 0,
      loaded: !!library,
      lifecycle: library?.lifecycle,
      packageVersion: library?.version,
    };
    for (const item of getAppletCatalog().filter(item => item.optional)) {
      const instanceAid = item.instanceAid ?? item.appletAid;
      const instance = instanceAid
        ? await registry.getEntry(0x40, hexToUint8Array(instanceAid))
        : undefined;
      const loaded = await registry.getEntry(
        0x10,
        hexToUint8Array(item.packageAid),
      );
      result.optional[item.stage] = {
        installed: instanceAid
          ? !!instance
          : !!loaded && loaded.lifecycle === 1 && loaded.modules.length === 0,
        aid: instance && uint8ArrayToHex(instance.aid),
        loaded: !!loaded,
        lifecycle: instance?.lifecycle ?? loaded?.lifecycle,
        packageVersion: loaded?.version,
      };
    }
  };

  try {
    try {
      await readRegistry(await GlobalPlatformInstaller.inspect(transceive));
    } catch (error) {
      signal?.throwIfAborted();
      if (
        !authenticateRegistry ||
        !(error instanceof AppletISOError && error.sw === 0x6982)
      ) {
        throw error;
      }
      // Explicit applet-management scans may authenticate to read the complete
      // inventory before asking the user to confirm affected applets.
      await readRegistry(await GlobalPlatformInstaller.open(transceive));
    }
  } catch (error) {
    signal?.throwIfAborted();
    rethrowConnectionError(error);
    result.registryError = error;
  }

  signal?.throwIfAborted();
  if (result.identity.installed === undefined) {
    try {
      result.identity.installed = await probeApplet(
        createMonoidApplet().attachSession(sessionId),
        aids[0].appletAid,
      );
    } catch (error) {
      // Other SELECT statuses leave presence unknown; Hello may still work.
      if (!(error instanceof AppletISOError)) throw error;
    }
  }

  signal?.throwIfAborted();
  try {
    const monoid = createMonoidApplet(aids[1].appletAid).attachSession(
      sessionId,
    );
    if (!(await probeApplet(monoid, monoid.aid))) {
      throw new AppletNotFoundError(new Uint8Array(), monoid.aid);
    }
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
  selectedOptionalStages: readonly AppletStage[],
  signal?: AbortSignal,
  identityOptions: IdentityInstallationOptions = {},
): Promise<LoadedApplet[]> {
  signal?.throwIfAborted();
  const applicationData = identityApplicationData(identityOptions);

  if (!appletBundle) {
    throw new Error('The applet installation package is not available yet.');
  }

  const packages = await Promise.all(
    getAppletInstallationPlan(selectedOptionalStages).map(async item => {
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
        appletAid: item.appletAid ? hexToUint8Array(item.appletAid) : undefined,
        instanceAid: item.instanceAid
          ? hexToUint8Array(item.instanceAid)
          : undefined,
        ...(item.stage === 'identity' && applicationData
          ? {applicationData}
          : {}),
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
  selectedOptionalStages: readonly AppletStage[] = [],
  identityOptions: IdentityInstallationOptions = {},
): Promise<MonoidAppletHello> {
  signal?.throwIfAborted();
  onProgress({stage: 'checking'});
  const packages = await loadAppletPackages(
    selectedOptionalStages,
    signal,
    identityOptions,
  );
  const installer = await GlobalPlatformInstaller.open(
    cardTransceive(sessionId, signal),
  );
  await installPackages(installer, packages, onProgress, signal);
  return verifyInstallation(
    sessionId,
    packages.find(item => item.stage === 'monoid')!.appletAid!,
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
    expectedCardId,
    expectedCardAlias,
    expectedAppletAid,
    expectedBundle,
    expectedFingerprint,
    authorityPublicKey,
    authorityUrl,
    selectedOptionalStages = [],
    replaceStages,
    onCheckpoint,
    onProgress = () => {},
    signal,
  }: {
    fresh: boolean;
    checkpoint?: AppletReplacementCheckpoint;
    expectedPublicKey?: PublicKeyHex;
    expectedCardId?: MonoidIdHex;
    expectedCardAlias?: string | false;
    expectedAppletAid?: string;
    expectedBundle?: string | false;
    expectedFingerprint: string;
    authorityPublicKey?: Uint8Array;
    authorityUrl?: string;
    selectedOptionalStages?: readonly AppletStage[];
    replaceStages?: readonly AppletStage[];
    onCheckpoint: (checkpoint: AppletReplacementCheckpoint) => Promise<void>;
    onProgress?: (
      update: AppletInstallProgress | AppletReplacementProgress,
    ) => void;
    signal?: AbortSignal;
  },
): Promise<MonoidAppletHello> {
  signal?.throwIfAborted();
  onProgress({stage: 'checking'});
  const packages = await loadAppletPackages(selectedOptionalStages, signal, {
    cardId:
      fresh && expectedCardId !== undefined
        ? hexToUint8Array(expectedCardId)
        : undefined,
    authorityPublicKey: fresh ? authorityPublicKey : undefined,
    authorityUrl: fresh ? authorityUrl : undefined,
  });
  const identity = packages.find(item => item.stage === 'identity')!;
  const monoid = packages.find(item => item.stage === 'monoid')!;
  const allPackages = getAppletInstallationPlan(
    getAppletCatalog()
      .filter(item => item.optional)
      .map(item => item.stage),
  );
  const replacing: readonly AppletStage[] = fresh
    ? allPackages.map(item => item.stage)
    : (replaceStages ?? ['library', 'monoid']);
  const replacingSet = new Set<AppletStage>(replacing);
  for (const stage of replacing) {
    if (!(fresh ? allPackages : packages).some(item => item.stage === stage)) {
      throw new MonoidCardError('Unknown replacement applet');
    }
  }
  if (!fresh && replacingSet.has('identity')) {
    throw new MonoidCardError('Identity requires Fresh install');
  }
  for (const item of getAppletDependents([...replacingSet])) {
    if (packages.some(selected => selected.stage === item.stage))
      replacingSet.add(item.stage);
  }
  const replacingPackages = packages.filter(item =>
    replacingSet.has(item.stage),
  );
  const deletingPackages = allPackages
    .filter(item => replacingSet.has(item.stage))
    .map(item => ({
      stage: item.stage,
      packageAid: hexToUint8Array(item.packageAid),
      appletAid: item.appletAid ? hexToUint8Array(item.appletAid) : undefined,
      instanceAid: item.instanceAid
        ? hexToUint8Array(item.instanceAid)
        : undefined,
    }));
  if (!replacingPackages.length) throw new MonoidCardError('Select an applet');
  if (!fresh && uint8ArrayToHex(monoid.appletAid!) !== expectedAppletAid) {
    throw new Error('The applet identity changed in this installation package');
  }
  const information = await readCardInformation(sessionId, signal);
  if (getCardMaintenanceFingerprint(information) !== expectedFingerprint) {
    throw new Error('Wrong card');
  }
  const removals = [...deletingPackages].reverse().flatMap(applet => [
    ...(applet.appletAid
      ? [
          {
            checkpoint:
              `remove-${applet.stage}-instance` as AppletReplacementCheckpoint,
            applet,
            instance: true,
          },
        ]
      : []),
    {
      checkpoint:
        `remove-${applet.stage}-package` as AppletReplacementCheckpoint,
      applet,
      instance: false,
    },
  ]);
  const steps: AppletReplacementCheckpoint[] = [
    ...removals.map(step => step.checkpoint),
    'install',
    'verify',
  ];
  const position = checkpoint ? steps.indexOf(checkpoint) : 0;
  if (position < 0) throw new Error('Invalid card maintenance checkpoint');

  // A retained Monoid must authenticate the exact Identity before deletion.
  // If an acknowledged/uncertain previous DELETE removed it, only the saved
  // continuation can proceed without Hello; restoration checks Identity again.
  if (!fresh && position === 0) {
    const applet = createMonoidApplet(monoid.appletAid!).attachSession(
      sessionId,
    );
    const installed = await probeApplet(applet, applet.aid);
    signal?.throwIfAborted();
    if (installed) {
      const hello = await applet.hello({});
      assertSameCardWithBundle(
        hello,
        {
          id: expectedCardId!,
          alias: expectedCardAlias,
          publicKey: expectedPublicKey!,
          bundle: expectedBundle!,
        },
        'The card Bundle changed during maintenance',
      );
    } else if (!checkpoint) {
      throw new AppletNotFoundError(new Uint8Array(), applet.aid);
    }
  }
  signal?.throwIfAborted();

  if (steps[position] !== 'verify') {
    const installer = await GlobalPlatformInstaller.open(
      cardTransceive(sessionId, signal),
    );
    if (!fresh && !(await installer.getEntry(0x40, identity.appletAid!))) {
      throw new Error('The original Monoid Identity Applet is missing');
    }
    const installedPackages = await installer.getEntries(0x10);
    // Other platform and application packages stay untouched. Check known
    // dependents here; non-cascading DELETE lets GP protect any other imports.
    for (const dependent of getAppletDependents([...replacingSet])) {
      if (
        !replacingSet.has(dependent.stage) &&
        installedPackages.some(
          item => uint8ArrayToHex(item.aid) === dependent.packageAid,
        )
      ) {
        throw new MonoidCardError('Include dependent applets');
      }
    }
    const installedInstances = await installer.getEntries(0x40);
    const pendingRemovals = removals.slice(position).filter(removal => {
      const {applet, instance} = removal;
      const aid = uint8ArrayToHex(
        instance
          ? (applet.instanceAid ?? applet.appletAid!)
          : applet.packageAid,
      );
      return (instance ? installedInstances : installedPackages).some(
        entry => uint8ArrayToHex(entry.aid) === aid,
      );
    });
    let removed = 0;
    for (const applet of deletingPackages) {
      const packageAid = uint8ArrayToHex(applet.packageAid);
      const moduleAid = applet.appletAid && uint8ArrayToHex(applet.appletAid);
      const instanceAid =
        applet.appletAid &&
        uint8ArrayToHex(applet.instanceAid ?? applet.appletAid);
      const loaded = installedPackages.find(
        item => uint8ArrayToHex(item.aid) === packageAid,
      );
      if (
        loaded?.modules.some(aid => uint8ArrayToHex(aid) !== moduleAid) ||
        installedInstances.some(
          item =>
            item.packageAid &&
            uint8ArrayToHex(item.packageAid) === packageAid &&
            uint8ArrayToHex(item.aid) !== instanceAid,
        )
      ) {
        throw new MonoidCardError('Unknown card applet');
      }
    }
    for (const step of steps.slice(position)) {
      signal?.throwIfAborted();
      await onCheckpoint(step);
      signal?.throwIfAborted();
      if (step === 'verify') break;
      if (step === 'install') {
        for (const applet of replacingPackages) {
          const instance = applet.appletAid
            ? await installer.getEntry(
                0x40,
                applet.instanceAid ?? applet.appletAid,
              )
            : undefined;
          const loaded = await installer.getEntry(0x10, applet.packageAid);
          // An interrupted LOAD has no instance or item data. Discard only that
          // exact unfinished code package before an explicitly requested retry.
          if (
            !instance &&
            loaded &&
            (loaded.lifecycle !== 1 ||
              (applet.appletAid
                ? !loaded.modules.some(
                    aid =>
                      uint8ArrayToHex(aid) ===
                      uint8ArrayToHex(applet.appletAid!),
                  )
                : loaded.modules.length !== 0))
          ) {
            onProgress({
              stage: 'deleting',
              applet: applet.stage,
              completed: 0,
              total: 1,
            });
            await installer.removePackage(applet.packageAid);
            onProgress({
              stage: 'deleting',
              applet: applet.stage,
              completed: 1,
              total: 1,
            });
          }
          await installPackages(installer, [applet], onProgress, signal);
        }
      } else {
        const removal = removals.find(removal => removal.checkpoint === step)!;
        const {applet} = removal;
        const pending = pendingRemovals.includes(removal);
        const progress = (): void =>
          onProgress({
            stage: 'deleting',
            applet: applet.stage,
            completed: removed,
            total: pendingRemovals.length,
          });
        if (pending) progress();
        if (removal.instance) {
          await installer.removeInstance(
            applet.instanceAid ?? applet.appletAid!,
          );
        } else {
          await installer.removePackage(applet.packageAid);
        }
        if (pending) {
          removed++;
          progress();
        }
      }
    }
  }

  const hello = await verifyInstallation(
    sessionId,
    monoid.appletAid!,
    onProgress,
    signal,
  );
  if (!fresh) {
    assertSameCardWithBundle(
      hello,
      {
        id: expectedCardId!,
        alias: expectedCardAlias,
        publicKey: expectedPublicKey!,
        bundle: expectedBundle!,
      },
      'The card Bundle changed during maintenance',
    );
  }
  if (
    fresh &&
    expectedCardId !== undefined &&
    uint8ArrayToHex(hello.id) !== expectedCardId
  ) {
    throw new Error('Card ID changed during maintenance');
  }

  return hello;
}
