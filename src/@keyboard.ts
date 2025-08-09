import {Keyboard as CapacitorKeyboard} from '@capacitor/keyboard';
import {makeObservable, runInAction} from 'mobx';

export class Keyboard {
  shown = false;

  constructor() {
    makeObservable(this, {
      shown: true,
    });

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
