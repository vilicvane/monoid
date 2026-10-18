import {observable, runInAction} from 'mobx';

import {MonoidPIN, PublicKey, SafeIndex} from '../../../../@atomics.js';
import {AppletISOError} from '../../../../@lib/applet.js';
import {CBORAppletError} from '../../../../@lib/cbor-applet.js';
import {
  type MonoidApplet,
  MonoidAppletHelloWithSafe,
  MonoidAppletInvalidPINError,
  MonoidCardError,
  MonoidWrongCardError,
} from '../../../../@lib/monoid/index.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../../../@utils/index.js';
import type {ScannedCardData, ScannedCardItemData} from '../common.js';

export type CardBackupIdentity = {
  id: string;
  publicKey: string;
};

export type CardBackupItem = Pick<
  ScannedCardItemData,
  'index' | 'type' | 'alias' | 'secret'
> & {
  selected: boolean;
};

export type CardBackupTransfer = {
  index: string;
  exported?: {key?: string; alias?: string; data: string};
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
    !/^04[0-9a-f]{128}$/i.test(source.publicKey)
  ) {
    throw new MonoidCardError(
      'This card did not provide a valid Safe identity.',
    );
  }

  const selectedIndexes =
    sourceIndexes === undefined ? undefined : new Set(sourceIndexes);
  const backupItems = items.map(({index, type, alias, secret}) => {
    if (!/^[0-9a-f]{20}$/i.test(index)) {
      throw new MonoidCardError('The card returned an invalid item index.');
    }

    return {
      index,
      ...(type !== undefined && {type}),
      ...(alias !== undefined && {alias}),
      secret,
      selected: selectedIndexes?.has(index) ?? true,
    };
  });

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

  return {
    source: {
      id: source.id.toLowerCase(),
      publicKey: source.publicKey.toLowerCase(),
    },
    items: backupItems,
    targets: [],
    targetsConfirmed: false,
    importStarted: false,
    complete: false,
  };
}

export function readBackupCardIdentity(
  hello: MonoidAppletHelloWithSafe,
): CardBackupIdentity {
  const {id, publicKey} = hello.safe;

  if (id.length !== 4 || publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new MonoidCardError(
      'This card did not provide a valid Safe identity.',
    );
  }

  return {id: uint8ArrayToHex(id), publicKey: uint8ArrayToHex(publicKey)};
}

export function getBackupCardIdentity(
  hello: MonoidAppletHelloWithSafe,
): CardBackupIdentity {
  const identity = readBackupCardIdentity(hello);

  assertBackupPINsNotBlocked(hello);

  if (hello.pin === false || hello.safe.pin === false || !hello.safe.unlocked) {
    throw new MonoidCardError('Initialize card from Safe');
  }

  return identity;
}

function assertBackupPINsNotBlocked(hello: MonoidAppletHelloWithSafe): void {
  if (hello.safe.pin === 0) {
    throw new MonoidCardError('Safe PIN blocked');
  }

  if (hello.pin === 0) {
    throw new MonoidCardError('Access PIN blocked');
  }
}

export function assertBackupCard(
  hello: MonoidAppletHelloWithSafe,
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

export async function initializeBackupTarget(
  applet: MonoidApplet,
  hello: MonoidAppletHelloWithSafe,
  expected: MonoidAppletHelloWithSafe,
  pin: string,
  signal: AbortSignal,
): Promise<MonoidAppletHelloWithSafe> {
  const identity = readBackupCardIdentity(hello);
  const expectedIdentity = readBackupCardIdentity(expected);

  if (identity.publicKey !== expectedIdentity.publicKey) {
    throw new MonoidWrongCardError(expectedIdentity.id);
  }

  assertBackupPINsNotBlocked(hello);
  throwIfCancelled(signal);

  if (expected.safe.pin === false && hello.safe.pin !== false) {
    throw new MonoidCardError(
      'This card has already been initialized. Add it again to continue.',
    );
  }

  if (!MonoidPIN.is(pin)) {
    throw new MonoidCardError('Safe PIN must contain 6 to 16 characters.');
  }

  if (hello.pin !== false && hello.safe.pin !== false && hello.safe.unlocked) {
    getBackupCardIdentity(hello);
    return hello;
  }

  if (hello.safe.pin === false && hello.pin !== false) {
    throw new MonoidCardError(
      'This card’s PIN state needs attention. Initialize it from Safe first.',
    );
  }

  if (hello.safe.pin !== false) {
    try {
      await applet.authenticate({safe: true, pin});
    } catch (error) {
      if (
        error instanceof CBORAppletError &&
        MonoidAppletInvalidPINError.is(error.source)
      ) {
        throw new MonoidCardError(
          error.source.tries === 0
            ? 'Safe PIN blocked'
            : `Incorrect Safe PIN, ${error.source.tries} ${error.source.tries === 1 ? 'try' : 'tries'} left`,
        );
      }

      throw error;
    }
  }

  throwIfCancelled(signal);
  // The firmware initializes an unset Access PIN to this same value. Existing
  // Access PINs are preserved, including when restoring Safe access.
  await applet.setPIN({safe: true, pin});
  throwIfCancelled(signal);
  const initialized = MonoidAppletHelloWithSafe.satisfies(
    await applet.hello({safe: true}),
  );
  throwIfCancelled(signal);
  assertBackupCard(initialized, expectedIdentity);
  return initialized;
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
    this.updateTarget({
      ...target,
      items: target.items.map(current =>
        current.index === transfer.index ? transfer : current,
      ),
      complete: false,
    });
  }

  readSource(
    applet: MonoidApplet,
    hello: MonoidAppletHelloWithSafe,
    signal: AbortSignal,
    sourceIndexes?: readonly string[],
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

      this.setBackup(
        createBackup(
          source,
          items.map(({index, type, alias, secret}) => ({
            index: uint8ArrayToHex(index),
            ...(type !== undefined && {type}),
            ...(alias !== undefined && {alias}),
            secret,
          })),
          indexes,
        ),
      );
    });
  }

  addTarget(hello: MonoidAppletHelloWithSafe): Promise<void> {
    return this.exclusive(() => {
      const backup = this.requireEditableBackup();
      const target = getBackupCardIdentity(hello);

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
    hello: MonoidAppletHelloWithSafe,
    pin: string,
    signal: AbortSignal,
    onProgress: (current: number, total: number) => void,
  ): Promise<void> {
    return this.exclusive(async () => {
      const backup = this.requireBackup();
      assertBackupCard(hello, backup.source);

      if (!backup.targetsConfirmed) {
        throw new MonoidCardError('Confirm the destination cards first.');
      }

      if (hello.safe.pin === 0) {
        throw new MonoidCardError('Safe PIN blocked');
      }

      if (!MonoidPIN.is(pin)) {
        throw new MonoidCardError('Safe PIN must contain 6 to 16 characters.');
      }

      throwIfCancelled(signal);

      try {
        await applet.authenticate({safe: true, pin});
      } catch (error) {
        if (
          error instanceof CBORAppletError &&
          MonoidAppletInvalidPINError.is(error.source)
        ) {
          throw new MonoidCardError(
            error.source.tries === 0
              ? 'Safe PIN blocked'
              : `Incorrect Safe PIN, ${error.source.tries} ${error.source.tries === 1 ? 'try' : 'tries'} left`,
          );
        }

        throw error;
      }

      const transfers = backup.targets.flatMap(target => target.items);
      let completed = transfers.filter(item => item.exported).length;
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
          const exported = await applet.exportItem({
            index: SafeIndex.satisfies(hexToUint8Array(item.index)),
            recipientPublicKey,
          });

          // Each target receives its own encrypted artifact. Its metadata must
          // retain the exact values and omitted/empty distinction from Export.
          this.updateTransfer(target.publicKey, {
            ...item,
            exported: {
              ...(exported.key !== undefined && {
                key: uint8ArrayToHex(exported.key),
              }),
              ...(exported.alias !== undefined && {alias: exported.alias}),
              data: uint8ArrayToHex(exported.data),
            },
          });
          onProgress(++completed, transfers.length);
        }
      }

      throwIfCancelled(signal);
    });
  }

  importItems(
    applet: MonoidApplet,
    hello: MonoidAppletHelloWithSafe,
    signal: AbortSignal,
    onProgress: (current: number, total: number) => void,
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
      const selected = target.items;

      if (!selected.length || selected.some(item => !item.exported)) {
        throw new MonoidCardError(
          'Export all selected items for this destination from the source first.',
        );
      }

      const senderPublicKey = PublicKey.satisfies(
        hexToUint8Array(backup.source.publicKey),
      );
      let completed = selected.filter(item => item.imported).length;
      onProgress(completed, selected.length);

      for (const item of selected) {
        if (item.imported) {
          continue;
        }

        const exported = item.exported!;
        throwIfCancelled(signal);
        const request = {
          index: SafeIndex.satisfies(hexToUint8Array(item.index)),
          senderPublicKey,
          ...(exported.key !== undefined && {
            key: hexToUint8Array(exported.key),
          }),
          ...(exported.alias !== undefined && {alias: exported.alias}),
          data: hexToUint8Array(exported.data),
        };

        const current = this.requireBackup();

        if (!current.importStarted) {
          // A lost response may still mean the card committed the import.
          this.setBackup({...current, importStarted: true});
        }

        try {
          await applet.importItem(request);
        } catch (error) {
          if (error instanceof AppletISOError && error.sw === 0x6985) {
            this.updateTransfer(target.publicKey, {...item, conflict: true});
            onProgress(++completed, selected.length);
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
        onProgress(++completed, selected.length);
      }

      throwIfCancelled(signal);
      const {items} = await applet.list({});
      const indexes = new Set<string>(
        items.map(item => uint8ArrayToHex(item.index)),
      );
      const current = this.requireBackup().targets.find(
        current => current.publicKey === target.publicKey,
      )!;
      const missing = current.items.some(
        item => item.imported && !indexes.has(item.index),
      );
      const verifiedItems = current.items.map(item =>
        item.imported && !indexes.has(item.index)
          ? {...item, imported: false}
          : item,
      );

      this.updateTarget({
        ...current,
        items: verifiedItems,
        complete: verifiedItems.every(item => item.imported),
      });

      if (missing) {
        throw new MonoidCardError(
          'Some imported items were not found on the destination card. Retry the remaining items.',
        );
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
