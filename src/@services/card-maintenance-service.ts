import {randomBytes, sha256, toUtf8Bytes} from 'ethers';
import {observable, runInAction} from 'mobx';

import {PublicKey, SafeIndex} from '../@atomics.js';
import {
  type CardInformation,
  readCardInformation,
} from '../@lib/global-platform/card-information.js';
import {
  type AppletInstallProgress,
  type AppletReplacementCheckpoint,
  type AppletReplacementProgress,
  type MonoidApplet,
  type MonoidAppletHello,
  MonoidCardError,
  createMonoidApplet,
  getBundledMonoidAppletAid,
  getCardMaintenanceFingerprint,
  getMonoidAppletBundleHash,
  getMonoidAppletBundleHashes,
  monoidCommandDefinitions,
  replaceMonoidApplets,
} from '../@lib/monoid/index.js';
import {hexToUint8Array, uint8ArrayToHex} from '../@utils/index.js';
import {xCBOR} from '../@x-value/index.js';

import type {StorageService} from './storage-service.js';

export type CardMaintenanceMode = 'update' | 'reinstall' | 'fresh';
export type CardMaintenancePhase =
  | 'ready'
  | 'replacing'
  | 'restore'
  | 'manual-restore'
  | 'setup';

export type CardMaintenanceItem = {
  index: string;
  key?: string;
  alias?: string;
  secret: boolean;
};

export type CardMaintenanceArchive = {
  items: (CardMaintenanceItem & {data: string})[];
  checksum: string;
};

export type CardMaintenanceOperation = {
  id: string;
  createdAt: number;
  mode: CardMaintenanceMode;
  phase: CardMaintenancePhase;
  card: {
    id?: string;
    publicKey?: string;
    bundle: string | false;
    appletAid: string;
    fingerprint: string;
  };
  bundleHashes: string[];
  archive?: CardMaintenanceArchive;
  checkpoint?: AppletReplacementCheckpoint;
  restored: number;
};

export type CardMaintenanceProgress =
  | AppletInstallProgress
  | AppletReplacementProgress
  | {stage: 'backup' | 'restore'; completed: number; total: number};

type MaintenanceStorage = {
  version: 1;
  operations: CardMaintenanceOperation[];
  installations?: {
    publicKey: string;
    appletAid: string;
    identityHash?: string;
    libraryHash?: string;
    monoidHash?: string;
  }[];
};

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    cardMaintenance: MaintenanceStorage;
  }
}

type PrepareOptions = {
  mode: Exclude<CardMaintenanceMode, 'fresh'>;
  cardInformation: CardInformation;
  /** Exact instance AID returned by the registry. */
  appletAid: string;
  onProgress?: (progress: CardMaintenanceProgress) => void;
  signal?: AbortSignal;
};

/** Only card-encrypted item envelopes and public metadata are persisted here. */
export class CardMaintenanceService {
  private readonly state = observable.box<MaintenanceStorage>({
    version: 1,
    operations: [],
  });
  private writing = Promise.resolve();
  private active = false;

  private constructor(
    private readonly storage: StorageService,
    state: MaintenanceStorage,
  ) {
    this.state.set(state);
  }

  get operations(): readonly CardMaintenanceOperation[] {
    return this.state.get().operations;
  }

  get(id: string): CardMaintenanceOperation | undefined {
    return this.operations.find(operation => operation.id === id);
  }

  matchOperation({
    hello,
    cardInformation,
  }: {
    hello?: MonoidAppletHello;
    cardInformation?: CardInformation;
  }): CardMaintenanceOperation | undefined {
    const publicKey = hello && uint8ArrayToHex(hello.publicKey);
    const fingerprint =
      cardInformation?.cplc && cardFingerprint(cardInformation);
    const operations = [...this.operations].reverse();
    const active = operations.filter(
      operation => operation.phase !== 'manual-restore',
    );
    return (
      active.find(
        operation => publicKey && operation.card.publicKey === publicKey,
      ) ??
      active.find(
        operation =>
          fingerprint === operation.card.fingerprint &&
          ((operation.mode === 'fresh' && operation.phase !== 'setup') ||
            (!publicKey && ['replacing', 'setup'].includes(operation.phase))),
      ) ??
      operations.find(
        operation =>
          operation.phase === 'manual-restore' &&
          publicKey &&
          operation.card.publicKey === publicKey,
      )
    );
  }

  /** The caller authenticates Secret PIN before this method; it is never stored. */
  async prepare(
    monoid: MonoidApplet,
    options: PrepareOptions,
  ): Promise<CardMaintenanceOperation> {
    return this.exclusive(async () => {
      const {signal, onProgress = () => {}} = options;
      signal?.throwIfAborted();
      const hello = await monoid.hello({});
      signal?.throwIfAborted();
      if (
        uint8ArrayToHex(monoid.aid) !== options.appletAid ||
        options.appletAid !== getBundledMonoidAppletAid()
      ) {
        throw new Error(
          'The installed applet identity does not match the update',
        );
      }
      const fingerprint = cardFingerprint(options.cardInformation);
      this.assertNoPending(hello, options.cardInformation);
      if (hello.pins.secret === false) {
        throw new Error('Set Secret PIN before updating this card');
      }
      const {grants} = await monoid.listAppletGrants({});
      signal?.throwIfAborted();
      if (grants.length > 0) {
        throw new MonoidCardError('Applet grants require separate recovery');
      }
      const operation = newOperation(options.mode, fingerprint, hello, monoid);

      if (!hello.bundle) {
        const manifest = normalizeItems((await monoid.list({})).items);
        const items: NonNullable<CardMaintenanceOperation['archive']>['items'] =
          [];
        onProgress({stage: 'backup', completed: 0, total: manifest.length});

        for (const item of manifest) {
          signal?.throwIfAborted();
          const exported = await monoid.exportItem({
            index: SafeIndex.satisfies(hexToUint8Array(item.index)),
            recipientPublicKey: hello.publicKey,
          });
          signal?.throwIfAborted();
          const archived = {
            ...item,
            key: exported.key && uint8ArrayToHex(exported.key),
            alias: exported.alias,
            data: uint8ArrayToHex(exported.data),
          };
          if (
            archived.key !== item.key ||
            archived.alias !== item.alias ||
            exported.data[0] !== 1
          ) {
            throw new Error('Card changed while creating the backup');
          }
          assertImportSize(operation, archived);
          items.push(archived);
          onProgress({
            stage: 'backup',
            completed: items.length,
            total: manifest.length,
          });
        }

        assertManifest(manifest, normalizeItems((await monoid.list({})).items));
        assertIdentity(operation, await monoid.hello({}), monoid);
        operation.archive = {items, checksum: archiveChecksum(items)};
      }

      signal?.throwIfAborted();
      // Acknowledged, read-back-verified storage precedes every destructive APDU.
      await this.save(operation, true);
      return this.require(operation.id);
    });
  }

  async prepareFresh(
    cardInformation: CardInformation,
    hello?: MonoidAppletHello,
    signal?: AbortSignal,
  ): Promise<CardMaintenanceOperation> {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      const existing = this.operations.find(
        operation =>
          operation.mode === 'fresh' &&
          operation.card.fingerprint === cardFingerprint(cardInformation),
      );
      if (existing) return existing;
      const operation = newOperation(
        'fresh',
        cardFingerprint(cardInformation),
        hello,
      );
      await this.save(operation);
      return this.require(operation.id);
    });
  }

  /** Explicitly resumed calls use the saved next step, never restart deletion. */
  async replace(
    sessionId: string,
    id: string,
    onProgress: (progress: CardMaintenanceProgress) => void = () => {},
    signal?: AbortSignal,
  ): Promise<MonoidAppletHello> {
    return this.exclusive(async () => {
      let operation = this.require(id);
      if (!['ready', 'replacing'].includes(operation.phase)) {
        const information = await readCardInformation(sessionId, signal);
        if (cardFingerprint(information) !== operation.card.fingerprint) {
          throw new Error('Wrong card');
        }
        const monoid = await createMonoidApplet(
          hexToUint8Array(operation.card.appletAid),
        ).openSession(sessionId);
        const hello = await monoid.hello({});
        assertIdentity(operation, hello, monoid);
        return hello;
      }
      if (operation.archive) assertArchive(operation.archive);
      if (
        operation.mode !== 'fresh' &&
        !operation.card.bundle &&
        !operation.archive
      ) {
        throw new Error('The card recovery archive is missing');
      }
      if (
        JSON.stringify(operation.bundleHashes) !==
        JSON.stringify(getMonoidAppletBundleHashes())
      ) {
        throw new Error('The applet package changed during card maintenance');
      }

      const hello = await replaceMonoidApplets(sessionId, {
        fresh: operation.mode === 'fresh',
        checkpoint: operation.checkpoint,
        expectedPublicKey: operation.card.publicKey,
        expectedAppletAid: operation.card.appletAid,
        expectedBundle: operation.card.bundle,
        expectedFingerprint: operation.card.fingerprint,
        onProgress,
        onCheckpoint: async checkpoint => {
          operation = {...operation, phase: 'replacing', checkpoint};
          await this.save(operation);
        },
        signal,
      });
      operation = {
        ...operation,
        phase:
          operation.mode === 'fresh'
            ? 'setup'
            : operation.card.bundle
              ? 'manual-restore'
              : 'restore',
      };
      if (operation.mode === 'fresh') {
        operation = {
          ...operation,
          card: {
            ...operation.card,
            id: uint8ArrayToHex(hello.id),
            publicKey: uint8ArrayToHex(hello.publicKey),
            bundle: hello.bundle ? uint8ArrayToHex(hello.bundle) : false,
          },
        };
      } else {
        assertIdentity(operation, hello, {
          aid: hexToUint8Array(operation.card.appletAid),
        });
      }
      await this.save(operation);
      await this.recordInstallation(hello, {
        identity: operation.mode === 'fresh',
        library: true,
        monoid: true,
        appletAid: operation.card.appletAid,
      });
      return hello;
    });
  }

  /** Reimports are idempotent; final verification must succeed before deletion. */
  async restore(
    monoid: MonoidApplet,
    id: string,
    onProgress: (progress: CardMaintenanceProgress) => void = () => {},
    signal?: AbortSignal,
  ): Promise<void> {
    return this.exclusive(async () => {
      let operation = this.require(id);
      if (operation.phase !== 'restore' || !operation.archive) {
        throw new Error('This operation has no automatic recovery archive');
      }
      assertArchive(operation.archive);
      signal?.throwIfAborted();
      assertIdentity(operation, await monoid.hello({}), monoid);
      const {items} = operation.archive;
      onProgress({stage: 'restore', completed: 0, total: items.length});

      // Replay the whole archive on explicit retry. Never trust only a saved
      // count after an uncertain card response or a later card data change.
      for (let index = 0; index < items.length; index++) {
        signal?.throwIfAborted();
        await monoid.importItem(importRequest(operation, items[index]));
        operation = {...operation, restored: index + 1};
        await this.save(operation);
        onProgress({
          stage: 'restore',
          completed: index + 1,
          total: items.length,
        });
      }

      signal?.throwIfAborted();
      onProgress({stage: 'verifying'});
      assertIdentity(operation, await monoid.hello({}), monoid);
      assertManifest(items, normalizeItems((await monoid.list({})).items));
      signal?.throwIfAborted();
      await this.remove(id);
    });
  }

  /** Bundle recovery reminders intentionally survive the completion screen. */
  async complete(id: string): Promise<void> {
    const operation = this.require(id);
    if (operation.mode !== 'fresh' || operation.phase !== 'setup') {
      throw new Error('Card recovery is not complete');
    }
    await this.remove(id);
  }

  isUpdateAvailable(hello: MonoidAppletHello): boolean | undefined {
    const saved = this.installation(hello);
    const updates = (['library', 'monoid'] as const).map(stage => {
      const bundled = getMonoidAppletBundleHash(stage);
      if (bundled === undefined) return false;
      const installed = saved?.[`${stage}Hash`];
      return installed === undefined ? undefined : installed !== bundled;
    });
    return updates.includes(true)
      ? true
      : updates.includes(undefined)
        ? undefined
        : false;
  }

  isIdentityUpdateAvailable(hello: MonoidAppletHello): boolean | undefined {
    const saved = this.installation(hello);
    return saved?.identityHash === undefined
      ? undefined
      : saved.identityHash !== getMonoidAppletBundleHash('identity');
  }

  /** Mark only components known to have loaded the bundled image, not skipped packages. */
  async recordInstallation(
    hello: MonoidAppletHello,
    options: {
      identity?: boolean;
      library?: boolean;
      monoid?: boolean;
      appletAid?: string;
    },
  ): Promise<void> {
    const publicKey = uint8ArrayToHex(hello.publicKey);
    const appletAid = options.appletAid ?? getBundledMonoidAppletAid();
    await this.write(current => {
      const installations = current.installations ?? [];
      const previous = installations.find(
        item => item.publicKey === publicKey && item.appletAid === appletAid,
      );
      return {
        ...current,
        installations: [
          ...installations.filter(
            item =>
              item.publicKey !== publicKey || item.appletAid !== appletAid,
          ),
          {
            ...previous,
            publicKey,
            appletAid,
            ...(options.identity
              ? {identityHash: getMonoidAppletBundleHash('identity')}
              : {}),
            ...(options.library
              ? {libraryHash: getMonoidAppletBundleHash('library')}
              : {}),
            ...(options.monoid
              ? {monoidHash: getMonoidAppletBundleHash('monoid')}
              : {}),
          },
        ],
      };
    });
  }

  static async create(
    storage: StorageService,
  ): Promise<CardMaintenanceService> {
    const state = await storage.get('cardMaintenance');
    if (state && (state.version !== 1 || !Array.isArray(state.operations))) {
      throw new Error('The saved card maintenance data is invalid');
    }
    for (const operation of state?.operations ?? []) {
      if (operation.archive) assertArchive(operation.archive);
    }
    return new CardMaintenanceService(
      storage,
      state ?? {version: 1, operations: []},
    );
  }

  private require(id: string): CardMaintenanceOperation {
    const operation = this.get(id);
    if (!operation) throw new Error('Card maintenance was not found');
    return operation;
  }

  private assertNoPending(
    hello: MonoidAppletHello | undefined,
    information: CardInformation,
  ): void {
    const fingerprint = cardFingerprint(information);
    if (
      this.operations.some(
        operation =>
          operation.phase !== 'manual-restore' &&
          (hello
            ? operation.card.publicKey === uint8ArrayToHex(hello.publicKey) ||
              (operation.mode === 'fresh' &&
                operation.phase !== 'setup' &&
                operation.card.fingerprint === fingerprint)
            : operation.card.fingerprint === fingerprint),
      )
    ) {
      throw new Error('Continue the existing card maintenance first');
    }
  }

  private async save(
    operation: CardMaintenanceOperation,
    replaceManualRestore = false,
  ): Promise<void> {
    await this.write(current => ({
      ...current,
      version: 1,
      operations: [
        ...current.operations.filter(
          saved =>
            saved.id !== operation.id &&
            !(
              replaceManualRestore &&
              saved.phase === 'manual-restore' &&
              saved.card.publicKey === operation.card.publicKey &&
              saved.card.appletAid === operation.card.appletAid
            ),
        ),
        operation,
      ],
    }));
  }

  private async remove(id: string): Promise<void> {
    await this.write(current => ({
      ...current,
      version: 1,
      operations: current.operations.filter(operation => operation.id !== id),
    }));
  }

  private installation(
    hello: MonoidAppletHello,
  ): NonNullable<MaintenanceStorage['installations']>[number] | undefined {
    return this.state
      .get()
      .installations?.find(
        item =>
          item.publicKey === uint8ArrayToHex(hello.publicKey) &&
          item.appletAid === getBundledMonoidAppletAid(),
      );
  }

  private async write(
    update: (state: MaintenanceStorage) => MaintenanceStorage,
  ): Promise<void> {
    const write = this.writing
      .catch(() => {})
      .then(async () => {
        const next = JSON.parse(
          JSON.stringify(update(this.state.get())),
        ) as MaintenanceStorage;
        await this.storage.set('cardMaintenance', next);
        const saved = await this.storage.get('cardMaintenance');
        if (JSON.stringify(saved) !== JSON.stringify(next)) {
          throw new Error('Could not verify the saved card recovery data');
        }
        runInAction(() => this.state.set(next));
      });
    this.writing = write;
    await write;
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.active) throw new Error('Card maintenance is already running');
    this.active = true;
    try {
      return await action();
    } finally {
      this.active = false;
    }
  }
}

export function cardFingerprint(information: CardInformation): string {
  return getCardMaintenanceFingerprint(information);
}

function newOperation(
  mode: CardMaintenanceMode,
  fingerprint: string,
  hello?: MonoidAppletHello,
  monoid: Pick<MonoidApplet, 'aid'> = {
    aid: hexToUint8Array(getBundledMonoidAppletAid()),
  },
): CardMaintenanceOperation {
  return {
    id: uint8ArrayToHex(randomBytes(16)),
    createdAt: Date.now(),
    mode,
    phase: 'ready',
    card: {
      id: hello && uint8ArrayToHex(hello.id),
      publicKey: hello && uint8ArrayToHex(hello.publicKey),
      bundle: hello?.bundle ? uint8ArrayToHex(hello.bundle) : false,
      appletAid: uint8ArrayToHex(monoid.aid),
      fingerprint,
    },
    bundleHashes: getMonoidAppletBundleHashes(),
    restored: 0,
  };
}

function normalizeItems(
  items: Awaited<ReturnType<MonoidApplet['list']>>['items'],
): CardMaintenanceItem[] {
  const normalized = items.map(item => ({
    index: uint8ArrayToHex(item.index),
    key: item.key && uint8ArrayToHex(item.key),
    alias: item.alias,
    secret: item.secret,
  }));
  if (new Set(normalized.map(item => item.index)).size !== normalized.length) {
    throw new Error('The card returned duplicate item indexes');
  }
  return normalized;
}

function assertManifest(
  expected: CardMaintenanceItem[],
  actual: CardMaintenanceItem[],
): void {
  const normalize = (items: CardMaintenanceItem[]): string =>
    JSON.stringify(
      items
        .map(({index, key, alias, secret}) => ({index, key, alias, secret}))
        .sort((left, right) => left.index.localeCompare(right.index)),
    );
  if (normalize(expected) !== normalize(actual)) {
    throw new Error('The card item list does not match the recovery archive');
  }
}

function assertIdentity(
  operation: CardMaintenanceOperation,
  hello: MonoidAppletHello,
  monoid: Pick<MonoidApplet, 'aid'>,
): void {
  if (
    uint8ArrayToHex(hello.publicKey) !== operation.card.publicKey ||
    uint8ArrayToHex(monoid.aid) !== operation.card.appletAid
  ) {
    throw new Error('Wrong card');
  }
  const bundle = hello.bundle ? uint8ArrayToHex(hello.bundle) : false;
  if (bundle !== operation.card.bundle) {
    throw new Error('The card Bundle changed during maintenance');
  }
}

function archiveChecksum(items: CardMaintenanceArchive['items']): string {
  return sha256(toUtf8Bytes(JSON.stringify(items)));
}

function assertArchive(archive: CardMaintenanceArchive): void {
  if (archive.checksum !== archiveChecksum(archive.items)) {
    throw new Error('The card recovery archive failed its integrity check');
  }
}

function importRequest(
  operation: CardMaintenanceOperation,
  item: CardMaintenanceArchive['items'][number],
): Parameters<MonoidApplet['importItem']>[0] {
  return {
    index: SafeIndex.satisfies(hexToUint8Array(item.index)),
    senderPublicKey: PublicKey.satisfies(
      hexToUint8Array(operation.card.publicKey!),
    ),
    key: item.key === undefined ? undefined : hexToUint8Array(item.key),
    alias: item.alias,
    data: hexToUint8Array(item.data),
  };
}

function assertImportSize(
  operation: CardMaintenanceOperation,
  item: CardMaintenanceArchive['items'][number],
): void {
  const encoded = monoidCommandDefinitions.importItem.request.encode(
    xCBOR,
    importRequest(operation, item),
  );
  if (encoded.length > 8192) {
    throw new Error('An item is too large to restore on this card');
  }
}
