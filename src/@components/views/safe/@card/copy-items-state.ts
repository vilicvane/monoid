import {makeAutoObservable, runInAction} from 'mobx';

import type {ScannedCardData} from '../common.js';

import {CardBackupSession} from './card-backup-session.js';

export class CopyItemsState {
  readonly session: CardBackupSession;
  readonly interruptedCards = new Set<string>();
  readonly startedImports = new Set<string>();
  notice: string | undefined;
  failed = false;
  stepsExited = false;

  constructor(
    readonly sourceCard?: ScannedCardData,
    readonly sourceIndexes?: readonly string[],
  ) {
    this.session = new CardBackupSession(sourceCard, sourceIndexes);
    makeAutoObservable(this, {
      session: false,
      sourceCard: false,
      sourceIndexes: false,
    });
  }

  setNotice(notice: string | undefined, failed = false): void {
    this.notice = notice;
    this.failed = failed;
  }

  clearProgress(): void {
    this.interruptedCards.clear();
    this.startedImports.clear();
    this.stepsExited = false;
  }

  markInterrupted(publicKey: string, interrupted: boolean): void {
    if (interrupted) this.interruptedCards.add(publicKey);
    else this.interruptedCards.delete(publicKey);
  }

  startImport(publicKey: string): void {
    this.startedImports.add(publicKey);
  }

  exitSteps(): void {
    this.stepsExited = true;
  }

  async restart(): Promise<void> {
    await this.session.reset(this.sourceCard, this.sourceIndexes);
    runInAction(() => {
      this.clearProgress();
      this.setNotice(undefined);
    });
  }
}
