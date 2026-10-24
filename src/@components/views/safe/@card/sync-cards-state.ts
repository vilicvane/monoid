import {makeAutoObservable} from 'mobx';

import type {CardMaintenanceOperation} from '../../../../@services/index.js';
import type {CardAppletSnapshot} from '../../card/card-applet-snapshot.js';
import type {ScannedCardData} from '../common.js';

import {CardSyncSession} from './card-sync-session.js';

export class SyncCardsState {
  readonly session = new CardSyncSession();
  readonly interruptedCards = new Set<string>();
  sourceConsumed = false;
  stepsExited = false;
  maintenanceSaved = false;

  constructor(
    readonly sourceCard?: ScannedCardData,
    readonly maintenance?: CardMaintenanceOperation,
    readonly maintenanceCardSnapshot?: CardAppletSnapshot,
  ) {
    makeAutoObservable(this, {
      session: false,
      sourceCard: false,
      maintenance: false,
      maintenanceCardSnapshot: false,
    });
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
    this.sourceConsumed = true;
    this.stepsExited = false;
  }
}
