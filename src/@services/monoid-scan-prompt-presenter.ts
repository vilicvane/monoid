import {action, makeObservable, observable} from 'mobx';
import type {ReactNode} from 'react';

export type MonoidScanPromptPresentation = {
  owner: symbol;
  scanning: boolean;
  content: ReactNode;
  onDismiss: () => void;
  closing: boolean;
};

export class MonoidScanPromptPresenter {
  current: MonoidScanPromptPresentation | undefined;

  constructor() {
    makeObservable(this, {
      current: observable.ref,
      show: action,
      hide: action,
      remove: action,
    });
  }

  show(
    owner: symbol,
    options: Omit<MonoidScanPromptPresentation, 'owner' | 'closing'>,
  ): void {
    this.current = {...options, owner, closing: false};
  }

  hide(owner: symbol): void {
    if (this.current?.owner === owner && !this.current.closing) {
      this.current = {...this.current, closing: true};
    }
  }

  remove(presentation: MonoidScanPromptPresentation): void {
    if (this.current === presentation) {
      this.current = undefined;
    }
  }
}
