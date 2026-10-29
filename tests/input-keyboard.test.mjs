import assert from 'node:assert/strict';
import {beforeEach, mock, test} from 'node:test';

let platform;
let showCalls;
let hideCalls;
let settleShow;

mock.module('@capacitor/core', {
  namedExports: {Capacitor: {getPlatform: () => platform}},
});
mock.module('@capacitor/keyboard', {
  namedExports: {
    Keyboard: {
      show: () => {
        showCalls++;
        return new Promise(resolve => {
          settleShow = resolve;
        });
      },
      hide: async () => {
        hideCalls++;
        settleShow();
      },
    },
  },
});

const {showInputKeyboard} = await import('../.bld/app/@lib/input-keyboard.js');

beforeEach(() => {
  platform = 'android';
  showCalls = 0;
  hideCalls = 0;
  settleShow = undefined;
});

function input() {
  const element = {
    isConnected: true,
    readOnly: false,
    disabled: false,
    ownerDocument: {},
  };
  element.ownerDocument.activeElement = element;
  return element;
}

test('an already focused Android input explicitly requests the keyboard once', async () => {
  const cancel = showInputKeyboard(input());
  assert.equal(showCalls, 1);
  settleShow();
  await Promise.resolve();

  // Closing after dispatch must not hide a keyboard used by the next prompt.
  cancel();
  assert.equal(hideCalls, 0);
  assert.equal(showCalls, 1);
});

test('closing while Android waits for window focus cancels the pending show once', async () => {
  const cancel = showInputKeyboard(input());
  cancel();
  cancel();
  assert.equal(hideCalls, 1);
  await Promise.resolve();
  cancel();
  assert.equal(hideCalls, 1);
});

test('cleanup of the old prompt cannot cancel a new keyboard request', async () => {
  const oldCancel = showInputKeyboard(input());
  oldCancel();
  const newCancel = showInputKeyboard(input());
  oldCancel();
  assert.equal(showCalls, 2);
  assert.equal(hideCalls, 1);
  await Promise.resolve();
  oldCancel();
  assert.equal(hideCalls, 1);
  newCancel();
  assert.equal(hideCalls, 2);
});

test('web and iOS retain their platform autofocus behavior', () => {
  for (platform of ['web', 'ios']) showInputKeyboard(input())();
  assert.equal(showCalls, 0);
  assert.equal(hideCalls, 0);
});

test('detached, unfocused, disabled and closing inputs never request a keyboard', () => {
  for (const overrides of [
    {isConnected: false},
    {ownerDocument: {activeElement: null}},
    {disabled: true},
    {readOnly: true},
  ]) {
    showInputKeyboard(Object.assign(input(), overrides))();
  }
  assert.equal(showCalls, 0);
  assert.equal(hideCalls, 0);
});
