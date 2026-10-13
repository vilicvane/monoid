import {makeObservable, runInAction} from 'mobx';

import {PopupBackdropController} from './@popup-backdrop.js';

export class Portals {
  fab = document.createElement('div');

  fabActive = false;

  popup = document.createElement('div');

  popupBackdrop = new PopupBackdropController();

  constructor() {
    this.popup.append(this.popupBackdrop.element);

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
