import {makeObservable, runInAction} from 'mobx';

export class Portals {
  fab = document.createElement('div');

  fabActive = false;

  popup = document.createElement('div');

  constructor() {
    makeObservable(this, {
      fabActive: true,
    });

    this.observeFab();
  }

  private observeFab(): void {
    const observer = new MutationObserver(() => {
      runInAction(() => {
        this.fabActive = this.fab.children.length > 0;
      });
    });

    observer.observe(this.fab, {
      childList: true,
    });
  }
}
