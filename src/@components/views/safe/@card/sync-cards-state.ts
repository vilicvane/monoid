import {makeAutoObservable} from 'mobx';

import {MonoidCardError} from '../../../../@lib/monoid/index.js';
import type {
  CardMaintenanceBundleRecovery,
  CardMaintenanceOperation,
} from '../../../../@services/index.js';
import type {CardAppletSnapshot} from '../../card/card-applet-snapshot.js';
import type {ScannedCardData} from '../common.js';

import {CardSyncSession} from './card-sync-session.js';

export class SyncCardsState {
  readonly session = new CardSyncSession();
  readonly interruptedCards = new Set<string>();
  sourceConsumed = false;
  stepsExited = false;
  maintenanceSaved = false;
  readonly maintenanceCards = new Map<
    string,
    {
      operation: CardMaintenanceOperation;
      updateAvailable: boolean | undefined;
      target: boolean;
    }
  >();
  readonly recoveries = new Map<string, CardMaintenanceBundleRecovery>();
  readonly deferredCards = new Set<string>();

  constructor(
    readonly sourceCard?: ScannedCardData,
    readonly maintenance?: CardMaintenanceOperation,
    readonly maintenanceCardSnapshot?: CardAppletSnapshot,
  ) {
    if (maintenance?.card.publicKey)
      this.maintenanceCards.set(maintenance.card.publicKey, {
        operation: maintenance,
        updateAvailable: true,
        target: true,
      });
    makeAutoObservable(this, {
      session: false,
      sourceCard: false,
      maintenance: false,
      maintenanceCardSnapshot: false,
    });
  }

  get maintenanceTargets(): CardMaintenanceOperation[] {
    return this.session.cards.flatMap(card => {
      const candidate = this.maintenanceCards.get(card.publicKey);
      return candidate?.target ? [candidate.operation] : [];
    });
  }

  addMaintenanceCard(
    operation: CardMaintenanceOperation,
    updateAvailable: boolean | undefined,
  ): void {
    const key = operation.card.publicKey!;
    const previous = this.maintenanceCards.get(key);
    this.maintenanceCards.set(key, {
      operation,
      updateAvailable,
      target: previous?.target ?? false,
    });
  }

  selectMaintenanceCard(publicKey: string, target: boolean): void {
    if (
      this.session.phase !== 'collect' ||
      publicKey === this.maintenance?.card.publicKey
    )
      throw new MonoidCardError('Card targets are fixed');
    this.maintenanceCards.get(publicKey)!.target = target;
  }

  prepare(): void {
    if (this.maintenance) {
      if (
        this.maintenance.phase !== 'manual-restore' &&
        this.session.cards.some(
          card => !this.maintenanceCards.has(card.publicKey),
        )
      )
        throw new MonoidCardError('Add each maintenance card again');
      const targets = this.maintenanceTargets;
      const nonTargets = this.session.cards.filter(
        card =>
          !targets.some(target => target.card.publicKey === card.publicKey),
      );
      // A non-target can supply every archive. If all cards are targets, two
      // members must hold the merged result to export for each other.
      const writers = nonTargets.length
        ? nonTargets
        : this.session.cards.slice(0, 2);
      this.deferredCards.clear();
      for (const target of targets) {
        if (!writers.some(card => card.publicKey === target.card.publicKey))
          this.deferredCards.add(target.card.publicKey!);
      }
    }
    this.session.prepare();
  }

  get pendingMaintenanceCards(): typeof this.session.cards {
    return this.session.cards.filter(
      card => !this.deferredCards.has(card.publicKey) && !card.complete,
    );
  }

  needsExport(publicKey: string): boolean {
    return (
      (!this.deferredCards.has(publicKey) ||
        this.session.cards.some(
          card => card.publicKey === publicKey && card.complete,
        )) &&
      this.maintenanceTargets.some(
        target =>
          target.card.publicKey !== publicKey &&
          !this.recoveries.has(target.id),
      )
    );
  }

  acceptRecovery(recovery: CardMaintenanceBundleRecovery): void {
    for (const target of this.maintenanceTargets) {
      if (target.card.publicKey !== recovery.source.publicKey)
        this.recoveries.set(target.id, recovery);
    }
  }

  finishMaintenance(): void {
    this.maintenanceSaved = true;
  }

  consumeSource(): void {
    this.sourceConsumed = true;
  }

  markInterrupted(publicKey: string, interrupted: boolean): void {
    if (interrupted) this.interruptedCards.add(publicKey);
    else this.interruptedCards.delete(publicKey);
  }

  exitSteps(): void {
    this.stepsExited = true;
  }

  restart(): void {
    this.session.reset();
    this.interruptedCards.clear();
    this.recoveries.clear();
    this.deferredCards.clear();
    this.sourceConsumed = true;
    this.stepsExited = false;
  }
}
