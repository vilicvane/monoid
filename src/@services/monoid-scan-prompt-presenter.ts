import {action, makeObservable, observable} from 'mobx';
import type {ReactNode} from 'react';

export type MonoidScanPromptPresentation = {
  owner: symbol;
  token: symbol;
  scanning: boolean;
  error?: boolean;
  content: ReactNode;
  onDismiss: () => void;
  closing: boolean;
};

export class MonoidScanPromptPresenter {
  current: MonoidScanPromptPresentation | undefined;
  private completion:
    | {
        owner: symbol;
        promise: Promise<boolean>;
        resolve: (completed: boolean) => void;
      }
    | undefined;

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
    options: Omit<MonoidScanPromptPresentation, 'owner' | 'token' | 'closing'>,
  ): void {
    let token = this.current?.token;

    if (this.current?.owner !== owner || this.current.closing) {
      this.completion?.resolve(false);
      token = Symbol();
      let resolve!: (completed: boolean) => void;
      const promise = new Promise<boolean>(settle => {
        resolve = settle;
      });
      this.completion = {owner, promise, resolve};
    }

    this.current = {...options, owner, token: token!, closing: false};
  }

  hide(owner: symbol): Promise<boolean> {
    if (this.current && this.current.owner !== owner) {
      return Promise.resolve(false);
    }

    if (this.current && !this.current.closing) {
      this.current = {...this.current, closing: true};
    }

    return this.completion?.owner === owner
      ? this.completion.promise
      : Promise.resolve(true);
  }

  remove(presentation: MonoidScanPromptPresentation, completed: boolean): void {
    if (this.current?.token === presentation.token) {
      const exited = completed && this.current.closing;
      this.current = undefined;
      this.completion?.resolve(exited);
    }
  }
}
