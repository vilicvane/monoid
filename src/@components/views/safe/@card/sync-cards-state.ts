import {makeAutoObservable} from 'mobx';

import type {ScannedCardData} from '../common.js';

import {CardSyncSession} from './card-sync-session.js';

export class SyncCardsState {
  readonly session = new CardSyncSession();
  readonly interruptedCards = new Set<string>();
  sourceConsumed = false;
  stepsExited = false;

  constructor(readonly sourceCard?: ScannedCardData) {
    makeAutoObservable(this, {session: false, sourceCard: false});
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
