import {observable, runInAction} from 'mobx';

import {MonoidPIN, PublicKey, SafeIndex} from '../../../../@atomics.js';
import {AppletISOError} from '../../../../@lib/applet.js';
import {CBORAppletError} from '../../../../@lib/cbor-applet.js';
import {InvalidCardItemError} from '../../../../@lib/card-item-error.js';
import {
  type MonoidApplet,
  type MonoidAppletHello,
  MonoidAppletInvalidPINError,
  MonoidCardError,
  MonoidWrongCardError,
  initializeMonoidCard,
} from '../../../../@lib/monoid/index.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../../../@utils/index.js';
import {
  isCardDerivationItem,
  readCardDerivationRecord,
} from '../card-derivations.js';
import {
  CardItemMergeConflict,
  isCardImmutableItem,
  mergeCardItemData,
  validateCardImmutableItem,
} from '../card-item-merge.js';
import {
  isCardOTPItem,
  filterCardOTPAssociations,
  readCardOTPKeyIndex,
  validateCardOTPItem,
} from '../card-otp.js';
import {getCardResourceGroups} from '../card-resource-groups.js';
import type {ScannedCardData, ScannedCardItemData} from '../common.js';

export type CardBackupIdentity = {
  id: string;
  publicKey: string;
  bundle: string | false;
};

export type CardBackupItem = Pick<
  ScannedCardItemData,
  | 'index'
  | 'type'
  | 'alias'
  | 'secret'
  | 'metadata'
  | 'derivationRecord'
  | 'otpKeyIndex'
> & {
  selected: boolean;
};

export type CardBackupTransfer = {
  index: string;
  exported?: {
    metadata?: string;
    alias?: string;
    data: string;
    /** Public immutable records are retained for destination comparison. */
    plaintext?: string;
  };
  imported: boolean;
  conflict?: boolean;
};

export type CardBackupTarget = CardBackupIdentity & {
  items: CardBackupTransfer[];
  complete: boolean;
};

export type CardBackup = {
  source: CardBackupIdentity;
  items: CardBackupItem[];
  targets: CardBackupTarget[];
  targetsConfirmed: boolean;
  importStarted: boolean;
  complete: boolean;
};

function createBackup(
  source: CardBackupIdentity,
  items: readonly Omit<CardBackupItem, 'selected'>[],
  sourceIndexes?: readonly string[],
): CardBackup {
  if (
    !/^[0-9a-f]{8}$/i.test(source.id) ||
    !/^04[0-9a-f]{128}$/i.test(source.publicKey) ||
    (source.bundle !== false && !/^[0-9a-f]{64}$/i.test(source.bundle))
  ) {
    throw new MonoidCardError('This card did not provide a valid identity.');
  }

  const selectedIndexes =
    sourceIndexes === undefined ? undefined : new Set(sourceIndexes);
  const backupItems = items.map(
    ({index, type, alias, secret, metadata, derivationRecord, otpKeyIndex}) => {
      if (!/^[0-9a-f]{20}$/i.test(index)) {
        throw new MonoidCardError('The card returned an invalid item index.');
      }

      return {
        index,
        ...(type !== undefined && {type}),
        ...(alias !== undefined && {alias}),
        ...(metadata !== undefined && {metadata}),
        ...(otpKeyIndex !== undefined && {otpKeyIndex}),
        ...(derivationRecord !== undefined && {
          derivationRecord: {
            index: derivationRecord.index,
            wallets: derivationRecord.wallets.map(wallet => ({...wallet})),
          },
        }),
        secret,
        selected: selectedIndexes?.has(index) ?? true,
      };
    },
  );

  if (selectedIndexes) {
    const availableIndexes = new Set<string>(
      backupItems.map(item => item.index),
    );

    if ([...selectedIndexes].some(index => !availableIndexes.has(index))) {
      throw new MonoidCardError(
        'Some selected items were not found on the source card. Return to Card and scan it again.',
      );
    }
  }

  const groupedItems = getCardResourceGroups(backupItems).flatMap(group => {
    const selected = group.items.some(item => item.selected);

    return group.items.map(item => ({...item, selected}));
  });

  return {
    source: {
      id: source.id.toLowerCase(),
      publicKey: source.publicKey.toLowerCase(),
      bundle: source.bundle === false ? false : source.bundle.toLowerCase(),
    },
    items: groupedItems,
    targets: [],
    targetsConfirmed: false,
    importStarted: false,
    complete: false,
  };
}

export function readBackupCardIdentity(
  hello: MonoidAppletHello,
): CardBackupIdentity {
  const {id, publicKey, bundle} = hello;

  if (
    id.length !== 4 ||
    publicKey.length !== 65 ||
    publicKey[0] !== 0x04 ||
    (bundle !== false && bundle.length !== 32)
  ) {
    throw new MonoidCardError('This card did not provide a valid identity.');
  }

  return {
    id: uint8ArrayToHex(id),
    publicKey: uint8ArrayToHex(publicKey),
    bundle: bundle === false ? false : uint8ArrayToHex(bundle),
  };
}

export function getBackupCardIdentity(
  hello: MonoidAppletHello,
): CardBackupIdentity {
  const identity = readBackupCardIdentity(hello);

  assertBackupPINsNotBlocked(hello);

  if (hello.pins.access === false || hello.pins.secret === false) {
    throw new MonoidCardError('Initialize card from Safe');
  }

  return identity;
}

export function assertBackupBundle(
  source: CardBackupIdentity,
  target: CardBackupIdentity,
): void {
  if (source.bundle !== false && target.bundle !== source.bundle) {
    throw new MonoidCardError('Use a card in the same bundle');
  }
}

function assertBackupPINsNotBlocked(hello: MonoidAppletHello): void {
  if (hello.pins.secret === 0) {
    throw new MonoidCardError('Secret PIN blocked');
  }

  if (hello.pins.access === 0) {
    throw new MonoidCardError('Access PIN blocked');
  }
}

export function assertBackupCard(
  hello: MonoidAppletHello,
  expected: CardBackupIdentity,
): void {
  if (readBackupCardIdentity(hello).publicKey !== expected.publicKey) {
    throw new MonoidWrongCardError(expected.id);
  }

  getBackupCardIdentity(hello);
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw Object.assign(new Error('Copying was cancelled.'), {
      code: 'CANCELLED',
    });
  }
}

async function authenticateSecretPIN(
  applet: MonoidApplet,
  pin: string,
  signal: AbortSignal,
  onAuthenticated?: () => void,
): Promise<void> {
  if (!MonoidPIN.is(pin)) {
    throw new MonoidCardError('Secret PIN must contain 6 to 16 characters');
  }

  throwIfCancelled(signal);

  try {
    await applet.authenticate({secret: true, pin});
  } catch (error) {
    if (
      error instanceof CBORAppletError &&
      MonoidAppletInvalidPINError.is(error.source)
    ) {
      throw new MonoidCardError(
        error.source.tries === 0
          ? 'Secret PIN blocked'
          : `Incorrect Secret PIN, ${error.source.tries} ${error.source.tries === 1 ? 'try' : 'tries'} left`,
        {cause: error},
      );
    }

    throw error;
  }

  throwIfCancelled(signal);
  onAuthenticated?.();
}

async function hasMatchingImmutableItem(
  applet: MonoidApplet,
  item: CardBackupTransfer,
  signal: AbortSignal,
): Promise<boolean> {
  const index = SafeIndex.satisfies(hexToUint8Array(item.index));
  const exported = item.exported!;
  const source = {
    index: item.index,
    secret: false,
    metadata: exported.metadata,
    data: exported.plaintext,
  };
  validateCardImmutableItem(source);
  let metadata: Awaited<ReturnType<MonoidApplet['view']>>;
  try {
    metadata = await applet.view({index});
  } catch (error) {
    if (error instanceof CBORAppletError && error.source.code === 'NOT_FOUND') {
      throwIfCancelled(signal);
      return false;
    }
    throw error;
  }
  throwIfCancelled(signal);
  if (metadata.secret) {
    validateCardImmutableItem({index: item.index, secret: true});
  }

  const {data} = await applet.get({index});
  throwIfCancelled(signal);
  mergeCardItemData(
    {
      index: item.index,
      secret: metadata.secret,
      metadata: metadata.metadata && uint8ArrayToHex(metadata.metadata),
      data: uint8ArrayToHex(data),
    },
    source,
  );

  // Alias is display metadata; identical records keep the destination name.
  return true;
}

export async function initializeBackupTarget(
  applet: MonoidApplet,
  hello: MonoidAppletHello,
  expected: MonoidAppletHello,
  pin: string,
  signal: AbortSignal,
  onAuthenticated?: () => void,
  accessPIN?: MonoidPIN,
): Promise<MonoidAppletHello> {
  const identity = readBackupCardIdentity(hello);
  const expectedIdentity = readBackupCardIdentity(expected);

  if (identity.publicKey !== expectedIdentity.publicKey) {
    throw new MonoidWrongCardError(expectedIdentity.id);
  }

  assertBackupPINsNotBlocked(hello);
  throwIfCancelled(signal);

  if (hello.pins.access !== false && hello.pins.secret !== false) {
    return hello;
  }

  if (expected.pins.secret === false && hello.pins.secret !== false) {
    throw new MonoidCardError(
      'This card has already been initialized. Add it again to continue.',
    );
  }

  if (!MonoidPIN.is(pin)) {
    throw new MonoidCardError('Secret PIN must contain 6 to 16 characters.');
  }

  try {
    const initialized = await initializeMonoidCard(
      applet,
      hello,
      pin,
      signal,
      accessPIN,
    );
    assertBackupCard(initialized, expectedIdentity);
    onAuthenticated?.();
    return initialized;
  } catch (error) {
    if (
      error instanceof CBORAppletError &&
      MonoidAppletInvalidPINError.is(error.source)
    ) {
      throw new MonoidCardError(
        error.source.tries === 0
          ? 'Secret PIN blocked'
          : `Incorrect Secret PIN, ${error.source.tries} ${error.source.tries === 1 ? 'try' : 'tries'} left`,
        {cause: error},
      );
    }

    throw error;
  }
}

export class CardBackupSession {
  private current = observable.box<CardBackup | undefined>(undefined, {
    deep: false,
  });
  private running = observable.box(false);

  constructor(sourceCard?: ScannedCardData, sourceIndexes?: readonly string[]) {
    if (sourceCard) {
      this.setBackup(createBackup(sourceCard, sourceCard.items, sourceIndexes));
    }
  }

  get backup(): CardBackup | undefined {
    return this.current.get();
  }

  get busy(): boolean {
    return this.running.get();
  }

  private async exclusive(
    operation: () => void | Promise<void>,
  ): Promise<void> {
    if (this.busy) {
      throw new MonoidCardError(
        'An item copy operation is already in progress.',
      );
    }

    runInAction(() => this.running.set(true));

    try {
      await operation();
    } finally {
      runInAction(() => this.running.set(false));
    }
  }

  private requireBackup(): CardBackup {
    const backup = this.backup;

    if (!backup) {
      throw new MonoidCardError('Scan the source card first.');
    }

    return backup;
  }

  private setBackup(backup: CardBackup | undefined): void {
    runInAction(() => this.current.set(backup));
  }

  private requireEditableBackup(): CardBackup {
    const backup = this.requireBackup();

    if (backup.importStarted) {
      throw new MonoidCardError(
        'Destination cards cannot be changed after importing starts.',
      );
    }

    return backup;
  }

  private invalidateExports(backup: CardBackup): void {
    this.setBackup({
      ...backup,
      targets: backup.targets.map(target => ({
        ...target,
        items: [],
        complete: false,
      })),
      targetsConfirmed: false,
      complete: false,
    });
  }

  private updateTarget(target: CardBackupTarget): void {
    const backup = this.requireBackup();
    const targets = backup.targets.map(current =>
      current.publicKey === target.publicKey ? target : current,
    );
    this.setBackup({
      ...backup,
      targets,
      complete:
        backup.targetsConfirmed &&
        targets.length > 0 &&
        targets.every(current => current.complete),
    });
  }

  private updateTransfer(
    publicKey: string,
    transfer: CardBackupTransfer,
  ): void {
    const target = this.requireBackup().targets.find(
      target => target.publicKey === publicKey,
    )!;
    const items = target.items.map(current =>
      current.index === transfer.index ? transfer : current,
    );
    this.updateTarget({
      ...target,
      items,
      complete: items.length > 0 && items.every(item => item.imported),
    });
  }

  readSource(
    applet: MonoidApplet,
    hello: MonoidAppletHello,
    signal: AbortSignal,
    sourceIndexes?: readonly string[],
    onProgress?: (current: number, total: number) => void,
  ): Promise<void> {
    return this.exclusive(async () => {
      if (this.backup) {
        throw new MonoidCardError('Finish or restart the current copy first.');
      }

      const source = getBackupCardIdentity(hello);
      const indexes = sourceIndexes && [...sourceIndexes];
      throwIfCancelled(signal);
      const {items} = await applet.list({});
      throwIfCancelled(signal);
      const scannedItems: ScannedCardItemData[] = items.map(
        ({index, type, alias, secret, metadata}) => ({
          index: uint8ArrayToHex(index),
          ...(type !== undefined && {type}),
          ...(alias !== undefined && {alias}),
          ...(metadata !== undefined && {metadata: uint8ArrayToHex(metadata)}),
          secret,
        }),
      );
      const records = scannedItems.filter(
        item => isCardDerivationItem(item) || isCardImmutableItem(item),
      );
      const skippedIndexes = new Set<string>();

      if (records.length > 0) {
        onProgress?.(0, records.length);
      }

      for (const [index, item] of records.entries()) {
        throwIfCancelled(signal);
        try {
          if (isCardOTPItem(item)) {
            item.otpKeyIndex = await readCardOTPKeyIndex(applet, item);
          } else if (isCardDerivationItem(item)) {
            item.derivationRecord = await readCardDerivationRecord(
              applet,
              item,
            );
          } else {
            if (item.secret) validateCardImmutableItem(item);
            const {data} = await applet.get({
              index: hexToUint8Array(item.index),
            });
            throwIfCancelled(signal);
            validateCardImmutableItem({...item, data: uint8ArrayToHex(data)});
          }
        } catch (error) {
          if (!(error instanceof InvalidCardItemError)) throw error;
          skippedIndexes.add(item.index);
        }
        throwIfCancelled(signal);
        onProgress?.(index + 1, records.length);
      }

      throwIfCancelled(signal);
      const compatible = filterCardOTPAssociations(
        scannedItems.filter(item => !skippedIndexes.has(item.index)),
      );
      for (const item of scannedItems) {
        if (!compatible.includes(item)) skippedIndexes.add(item.index);
      }
      this.setBackup(
        createBackup(
          source,
          compatible,
          indexes?.filter(index => !skippedIndexes.has(index)),
        ),
      );
    });
  }

  addTarget(hello: MonoidAppletHello): Promise<void> {
    return this.exclusive(() => {
      const backup = this.requireEditableBackup();
      const target = getBackupCardIdentity(hello);
      assertBackupBundle(backup.source, target);

      if (target.publicKey === backup.source.publicKey) {
        throw new MonoidCardError('Use a different card');
      }

      if (
        backup.targets.some(current => current.publicKey === target.publicKey)
      ) {
        throw new MonoidCardError('Card already added');
      }

      this.invalidateExports({
        ...backup,
        targets: [...backup.targets, {...target, items: [], complete: false}],
      });
    });
  }

  removeTarget(publicKey: string): Promise<void> {
    return this.exclusive(() => {
      const backup = this.requireEditableBackup();

      if (!backup.targets.some(target => target.publicKey === publicKey)) {
        throw new MonoidCardError('This card is not one of the destinations.');
      }

      this.invalidateExports({
        ...backup,
        targets: backup.targets.filter(
          target => target.publicKey !== publicKey,
        ),
      });
    });
  }

  confirmTargets(): Promise<void> {
    return this.exclusive(() => {
      const backup = this.requireBackup();

      if (backup.targetsConfirmed) {
        throw new MonoidCardError(
          'The destination cards are already confirmed.',
        );
      }

      const selected = backup.items.filter(item => item.selected);

      if (!selected.length) {
        throw new MonoidCardError('Select at least one item to copy.');
      }

      if (!backup.targets.length) {
        throw new MonoidCardError('Add at least one destination card.');
      }

      this.setBackup({
        ...backup,
        targets: backup.targets.map(target => ({
          ...target,
          items: selected.map(({index}) => ({index, imported: false})),
          complete: false,
        })),
        targetsConfirmed: true,
        complete: false,
      });
    });
  }

  exportItems(
    applet: MonoidApplet,
    hello: MonoidAppletHello,
    pin: string,
    signal: AbortSignal,
    onProgress: (current: number, total: number) => void,
    onAuthenticated?: () => void,
  ): Promise<void> {
    return this.exclusive(async () => {
      const backup = this.requireBackup();
      assertBackupCard(hello, backup.source);
      if (readBackupCardIdentity(hello).bundle !== backup.source.bundle) {
        throw new MonoidCardError('Card bundle changed, scan source again');
      }

      if (!backup.targetsConfirmed) {
        throw new MonoidCardError('Confirm the destination cards first.');
      }

      await authenticateSecretPIN(applet, pin, signal, onAuthenticated);

      const transfers = backup.targets.flatMap(target => target.items);
      const bundleExports =
        backup.source.bundle === false
          ? undefined
          : new Map(
              transfers.flatMap(item =>
                item.exported ? [[item.index, item.exported] as const] : [],
              ),
            );
      let completed = transfers.filter(item => item.exported).length;
      throwIfCancelled(signal);
      onProgress(completed, transfers.length);

      for (const target of backup.targets) {
        const recipientPublicKey = PublicKey.satisfies(
          hexToUint8Array(target.publicKey),
        );

        for (const item of target.items) {
          if (item.exported) {
            continue;
          }

          throwIfCancelled(signal);
          let exported = bundleExports?.get(item.index);
          if (!exported) {
            let plaintext: string | undefined;
            if (isCardImmutableItem(item)) {
              const index = SafeIndex.satisfies(hexToUint8Array(item.index));
              const metadata = await applet.view({index});
              throwIfCancelled(signal);
              if (metadata.secret) {
                validateCardImmutableItem({index: item.index, secret: true});
              }
              const {data} = await applet.get({
                index,
              });
              throwIfCancelled(signal);
              plaintext = uint8ArrayToHex(data);
              validateCardImmutableItem({
                index: item.index,
                secret: metadata.secret,
                metadata:
                  metadata.metadata && uint8ArrayToHex(metadata.metadata),
                data: plaintext,
              });
              if (
                isCardOTPItem(item) &&
                validateCardOTPItem({
                  index: item.index,
                  secret: metadata.secret,
                  metadata:
                    metadata.metadata && uint8ArrayToHex(metadata.metadata),
                  data: plaintext,
                }) !==
                  backup.items.find(source => source.index === item.index)
                    ?.otpKeyIndex
              )
                throw new MonoidCardError(
                  'OTP account changed, start copy again',
                );
            }
            const result = await applet.exportItem({
              index: SafeIndex.satisfies(hexToUint8Array(item.index)),
              ...(backup.source.bundle === false && {recipientPublicKey}),
            });

            // Bundle envelopes are shared by every other member; asymmetric
            // envelopes remain specific to their recipient. Preserve metadata.
            exported = {
              ...(result.metadata !== undefined && {
                metadata: uint8ArrayToHex(result.metadata),
              }),
              ...(result.alias !== undefined && {alias: result.alias}),
              data: uint8ArrayToHex(result.data),
              ...(plaintext !== undefined && {plaintext}),
            };
            validateCardImmutableItem({
              index: item.index,
              secret: false,
              metadata: exported.metadata,
              data: plaintext,
            });
            bundleExports?.set(item.index, exported);
          }
          this.updateTransfer(target.publicKey, {...item, exported});
          throwIfCancelled(signal);
          onProgress(++completed, transfers.length);
        }
      }

      throwIfCancelled(signal);
    });
  }

  importItems(
    applet: MonoidApplet,
    hello: MonoidAppletHello,
    pin: string,
    signal: AbortSignal,
    onProgress: (current: number, total: number) => void,
    onAuthenticated?: () => void,
  ): Promise<void> {
    return this.exclusive(async () => {
      const backup = this.requireBackup();

      if (!backup.targetsConfirmed) {
        throw new MonoidCardError('Confirm the destination cards first.');
      }

      const identity = readBackupCardIdentity(hello);
      const target = backup.targets.find(
        target => target.publicKey === identity.publicKey,
      );

      if (!target) {
        throw new MonoidCardError(
          'Wrong card. Scan one of the destination cards.',
        );
      }

      assertBackupCard(hello, target);
      assertBackupBundle(backup.source, identity);
      const selected = target.items;

      if (!selected.length || selected.some(item => !item.exported)) {
        throw new MonoidCardError(
          'Export all selected items for this destination from the source first.',
        );
      }

      // Secret authorization is bound to this SELECT/session, never to the
      // retained copy state. Authenticate again before each import attempt.
      await authenticateSecretPIN(applet, pin, signal, onAuthenticated);

      const senderPublicKey = PublicKey.satisfies(
        hexToUint8Array(backup.source.publicKey),
      );
      let completed = selected.filter(item => item.imported).length;
      let total = selected.length;
      throwIfCancelled(signal);
      onProgress(completed, total);

      for (const item of selected) {
        if (item.imported) {
          continue;
        }

        const sourceIndex = backup.items.find(
          source => source.index === item.index,
        )?.otpKeyIndex;
        if (
          sourceIndex &&
          !this.requireBackup()
            .targets.find(current => current.publicKey === target.publicKey)!
            .items.find(source => source.index === sourceIndex)?.imported
        ) {
          this.updateTransfer(target.publicKey, {...item, conflict: true});
          continue;
        }

        const exported = item.exported!;
        throwIfCancelled(signal);
        const request = {
          index: SafeIndex.satisfies(hexToUint8Array(item.index)),
          ...(backup.source.bundle === false && {senderPublicKey}),
          ...(exported.metadata !== undefined && {
            metadata: hexToUint8Array(exported.metadata),
          }),
          ...(exported.alias !== undefined && {alias: exported.alias}),
          data: hexToUint8Array(exported.data),
        };

        try {
          if (
            !isCardImmutableItem(item) ||
            !(await hasMatchingImmutableItem(applet, item, signal))
          ) {
            const current = this.requireBackup();
            if (!current.importStarted) {
              // A lost response may still mean the card committed the import.
              this.setBackup({...current, importStarted: true});
            }
            await applet.importItem(request);
          }
        } catch (error) {
          if (error instanceof InvalidCardItemError) {
            const current = this.requireBackup().targets.find(
              current => current.publicKey === target.publicKey,
            )!;
            const items = current.items.filter(
              current => current.index !== item.index,
            );
            this.updateTarget({
              ...current,
              items,
              complete: items.every(current => current.imported),
            });
            total--;
            throwIfCancelled(signal);
            onProgress(completed, total);
            continue;
          }
          if (
            error instanceof CardItemMergeConflict ||
            (error instanceof AppletISOError && error.sw === 0x6985)
          ) {
            this.updateTransfer(target.publicKey, {...item, conflict: true});
            throwIfCancelled(signal);
            onProgress(completed, total);
            continue;
          }

          throw error;
        }

        // Acknowledged writes remain committed when the user cancels. Record
        // them before checking cancellation or starting another command.
        this.updateTransfer(target.publicKey, {
          ...item,
          imported: true,
          conflict: false,
        });
        throwIfCancelled(signal);
        onProgress(++completed, total);
      }
    });
  }

  reset(
    sourceCard?: ScannedCardData,
    sourceIndexes?: readonly string[],
  ): Promise<void> {
    return this.exclusive(() => {
      this.setBackup(
        sourceCard
          ? createBackup(sourceCard, sourceCard.items, sourceIndexes)
          : undefined,
      );
    });
  }
}
