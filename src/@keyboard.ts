import {Capacitor} from '@capacitor/core';
import {Keyboard as CapacitorKeyboard} from '@capacitor/keyboard';
import {makeObservable, runInAction} from 'mobx';

export class Keyboard {
  shown = false;
  insetBottom = Capacitor.getPlatform() === 'android' ? 0 : undefined;

  constructor() {
    makeObservable(this, {
      shown: true,
      insetBottom: true,
    });

    if (Capacitor.getPlatform() === 'android') {
      void CapacitorKeyboard.addListener(
        'keyboardHeightChanged',
        ({keyboardHeight}) => {
          runInAction(() => {
            this.insetBottom = keyboardHeight;
          });
        },
      );
    }

    void CapacitorKeyboard.addListener('keyboardWillShow', () => {
      runInAction(() => {
        this.shown = true;
      });
    });

    void CapacitorKeyboard.addListener('keyboardWillHide', () => {
      runInAction(() => {
        this.shown = false;
      });
    });
  }
}
