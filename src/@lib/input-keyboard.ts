import {Capacitor} from '@capacitor/core';
import {Keyboard} from '@capacitor/keyboard';

export function showInputKeyboard(input: HTMLInputElement): () => void {
  if (
    Capacitor.getPlatform() !== 'android' ||
    !input.isConnected ||
    input.ownerDocument.activeElement !== input ||
    input.readOnly ||
    input.disabled
  ) {
    return () => {};
  }

  // DOM autofocus can finish before the biometric window releases the IME.
  // Android waits for native window focus; cancel that wait with the input.
  let pending = true;
  void Keyboard.show().then(
    () => {
      pending = false;
    },
    error => {
      pending = false;
      console.error('Could not show input keyboard.', error);
    },
  );

  return () => {
    if (!pending) return;
    pending = false;
    void Keyboard.hide().catch(error => {
      console.error('Could not cancel input keyboard.', error);
    });
  };
}
