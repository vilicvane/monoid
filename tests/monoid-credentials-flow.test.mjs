import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {afterEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

// Exercise the built hooks with effect cleanup and state-driven rerenders, without a DOM or sensor.
let rendering;
let fixture;
const mounted = [];
const sameDependencies = (left, right) =>
  left?.length === right?.length &&
  left.every((value, index) => Object.is(value, right[index]));

const hooks = {
  useRef(value) {
    return rendering.slot(() => ({current: value}));
  },
  useState(initial) {
    const owner = rendering;
    const slot = owner.slot(() => {
      const state = {
        value: typeof initial === 'function' ? initial() : initial,
      };
      state.set = value => {
        const next = typeof value === 'function' ? value(state.value) : value;
        if (!Object.is(state.value, next)) {
          state.value = next;
          owner.dirty = true;
        }
      };
      return state;
    });
    return [slot.value, slot.set];
  },
  useCallback(callback, dependencies) {
    const slot = rendering.slot(() => ({}));
    if (!sameDependencies(slot.dependencies, dependencies)) {
      slot.dependencies = dependencies;
      slot.callback = callback;
    }
    return slot.callback;
  },
  useEffect(effect, dependencies) {
    const slot = rendering.slot(() => ({}));
    if (!sameDependencies(slot.dependencies, dependencies)) {
      rendering.effects.push(() => {
        slot.cleanup?.();
        slot.dependencies = dependencies;
        slot.cleanup = effect();
      });
    }
  },
};
hooks.useLayoutEffect = hooks.useEffect;

mock.module('react', {namedExports: hooks});
mock.module('react/jsx-runtime', {
  namedExports: {
    jsx: (type, props) => ({type, props}),
    jsxs: (type, props) => ({type, props}),
    Fragment: 'fragment',
  },
});
mock.module('styled-components', {
  namedExports: {styled: {span: () => 'span'}},
});
const iconURL = import.meta.resolve('lucide-static/icons/x.svg');
registerHooks({
  load(url, context, nextLoad) {
    return url === iconURL
      ? {format: 'module', source: "export default 'x';", shortCircuit: true}
      : nextLoad(url, context);
  },
});
mock.module('capacitor-biometric-vault', {namedExports: {BiometricVault: {}}});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => fixture.entrances},
});
mock.module('../.bld/app/@utils/index.js', {
  namedExports: {uint8ArrayToHex: bytes => Buffer.from(bytes).toString('hex')},
});
mock.module('../.bld/app/@components/@ui/toast.js', {
  namedExports: {useToast: () => fixture.toast},
});
mock.module('../.bld/app/@components/@ui/use-input-modal.js', {
  namedExports: {
    useInputModal: () => {
      const owner = fixture;
      const [, setVisible] = hooks.useState(false);
      const show = hooks.useCallback(() => {
        const input = deferred();
        owner.inputs.push(input);
        setVisible(true);
        return input.promise.then(value => {
          setVisible(false);
          return value;
        });
      }, []);
      return [null, show];
    },
  },
});

class CBORAppletError extends Error {
  constructor(source) {
    super(source.code);
    this.source = source;
  }
}
mock.module('../.bld/app/@lib/cbor-applet.js', {
  namedExports: {CBORAppletError},
});
class IsoDepScanError extends Error {}
mock.module('../.bld/app/@lib/isodep.js', {
  namedExports: {IsoDepScanError},
});
mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {
    MonoidAppletInvalidPINError: {is: source => source?.code === 'INVALID_PIN'},
  },
});
const {isCredentialRequestCancelled} = await import(
  '../.bld/app/@services/monoid-credentials-store.js'
);
mock.module('../.bld/app/@services/index.js', {
  namedExports: {isCredentialRequestCancelled},
});

const {MonoidScanPromptPresenter} = await import(
  '../.bld/app/@services/monoid-scan-prompt-presenter.js'
);
const {useMonoidScanPrompt} = await import(
  '../.bld/app/@components/@monoid/monoid-scan-prompt.js'
);

class HookOwner {
  constructor(render) {
    this.render = render;
    this.slots = [];
    this.dirty = true;
    mounted.push(this);
  }

  slot(create) {
    const index = this.index++;
    return (this.slots[index] ??= create());
  }

  flush() {
    for (let passes = 0; this.dirty && !this.disposed; passes++) {
      assert.ok(passes < 20, 'Hook rerender loop');
      this.dirty = false;
      this.index = 0;
      this.effects = [];
      rendering = this;
      this.output = this.render();
      rendering = undefined;
      this.effects.forEach(effect => effect());
    }
  }

  unmount() {
    if (this.disposed) return;
    this.disposed = true;
    this.slots.forEach(slot => slot.cleanup?.());
  }
}

afterEach(() => {
  mounted.splice(0).forEach(owner => owner.unmount());
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return {promise, resolve, reject};
}

const PIN = 'Access 42!';
const OLD_PIN = 'Old PIN 1';
const CARD_ID = '01020304';
const OTHER_CARD_ID = '05060708';
const inactive = () =>
  Object.assign(new Error('App inactive'), {code: 'APP_INACTIVE'});
const cancelled = () =>
  Object.assign(new Error('Cancelled'), {code: 'CANCELLED'});
const readFailed = () =>
  Object.assign(new Error('Storage unavailable'), {code: 'IO_ERROR'});
const wrongPIN = () => new CBORAppletError({code: 'INVALID_PIN', tries: 4});

function mount(overrides = {}) {
  const state = {
    auth: 'access',
    cardId: CARD_ID,
    savedPINs: {},
    scans: [],
    inputs: [],
    notifications: [],
    errors: [],
    retryErrors: [],
    gets: 0,
    readSignals: [],
    authenticated: [],
    writes: [],
    removals: [],
    businessCalls: 0,
    businessCompleted: 0,
    exitedTokens: new Set(),
    ...overrides,
  };
  state.presenter = new MonoidScanPromptPresenter();
  state.toast = options => state.notifications.push(options);
  state.business = async applet => {
    state.businessCalls++;
    await state.onBusiness?.(applet);
    state.businessCompleted++;
  };
  const assertMutationReady = () => {
    const scan = state.scans.at(-1);
    assert.equal(
      scan.callbackReturned,
      true,
      'Card callback must return first',
    );
    assert.equal(scan.stopFinished, true, 'Native scan must stop first');
    assert.ok(
      state.exitedTokens.has(scan.presentationToken),
      'Card and backdrop exit animations must finish first',
    );
  };
  state.entrances = {
    router: {safe: {setupCard: () => ({$push() {}})}},
    monoidScanPromptPresenter: state.presenter,
    errorService: {
      catch: promise => promise.catch(error => state.retryErrors.push(error)),
    },
    monoidCredentialsStore: {
      async getPINs(signal) {
        state.gets++;
        state.readSignals.push(signal);
        return state.onGet
          ? state.onGet(signal)
          : Object.freeze({...state.savedPINs});
      },
      async setPIN(id, pin, signal) {
        assertMutationReady();
        state.writes.push({id, pin, signal});
        await state.onSet?.(signal);
        state.savedPINs[id] = pin;
      },
      async removePIN(id, expectedPIN, signal) {
        assertMutationReady();
        state.removals.push({id, expectedPIN, signal});
        await state.onRemove?.(signal);
        if (expectedPIN === undefined || state.savedPINs[id] === expectedPIN) {
          delete state.savedPINs[id];
        }
      },
    },
    monoidApplet: {
      standby(callback, onError, onCleanup) {
        assert.ok(
          state.scans.every(scan => scan.stopFinished),
          'A previous native scan must finish stopping before another starts',
        );
        const scan = {
          callback,
          onError,
          onCleanup,
          stopRequested: false,
          stopFinished: false,
          stop: deferred(),
        };
        state.scans.push(scan);
        return () => {
          scan.stopRequested = true;
          return scan.stop.promise;
        };
      },
    },
  };
  state.applet = {
    async hello() {
      return {
        id: new Uint8Array(Buffer.from(state.cardId, 'hex')),
        pin: 5,
        safe: {id: new Uint8Array([5]), pin: 5, unlocked: true},
      };
    },
    async authenticate({pin}) {
      state.authenticated.push(pin);
      await state.onAuthenticate?.(pin);
    },
  };
  fixture = state;
  state.owner = new HookOwner(() => {
    fixture = state;
    return useMonoidScanPrompt({auth: state.auth, retryOnError: true});
  });
  state.owner.flush();
  state.operation = state.owner.output[1]('Scan card', state.business);
  state.operation.then(
    () => {
      state.outcome = 'resolved';
    },
    error => {
      state.outcome = 'rejected';
      state.errors.push(error);
    },
  );
  state.owner.flush();
  state.flush = async () => {
    await setImmediate();
    state.owner.flush();
    await setImmediate();
    state.owner.flush();
  };
  state.tap = async ({cleanup = true} = {}) => {
    await state.flush();
    const scan = state.scans.at(-1);
    assert.ok(scan, 'Credential preloading must finish before scanning');
    assert.equal(scan.stopRequested, false);
    scan.presentationToken = state.presenter.current.token;
    try {
      await scan.callback(state.applet);
    } catch (error) {
      scan.onError(error);
    }
    scan.callbackReturned = true;
    if (cleanup && !scan.stopRequested) scan.onCleanup?.();
    await state.flush();
    return scan;
  };
  state.finishStop = async (scan = state.scans.at(-1)) => {
    assert.equal(scan.stopRequested, true);
    scan.stopFinished = true;
    scan.stop.resolve();
    await state.flush();
  };
  state.finishAnimation = async (completed = true) => {
    const presentation = state.presenter.current;
    assert.equal(presentation?.closing, true);
    if (completed) state.exitedTokens.add(presentation.token);
    state.presenter.remove(presentation, completed);
    await state.flush();
  };
  state.finishExit = async (order = 'stop-first') => {
    if (order === 'stop-first') {
      await state.finishStop();
      await state.finishAnimation();
    } else {
      await state.finishAnimation();
      await state.finishStop();
    }
  };
  state.enterPIN = async (value = PIN) => {
    assert.ok(state.inputs.length > 0, 'PIN input must already be shown');
    state.inputs.at(-1).resolve(value);
    await state.flush();
  };
  state.enterManualPIN = async () => {
    await state.tap();
    assert.equal(state.inputs.length, 0);
    await state.finishExit();
    await state.enterPIN();
    assert.equal(state.scans.length, 2);
  };
  return state;
}

for (const order of ['stop-first', 'animation-first']) {
  test(`prompt: ${order} waits for callback, native stop and animation before saving`, async () => {
    const state = mount();
    await state.enterManualPIN();
    const business = deferred();
    const save = deferred();
    state.onBusiness = () => business.promise;
    state.onSet = () => save.promise;
    const tapping = state.tap({cleanup: false});
    await state.flush();
    assert.equal(state.businessCalls, 1);
    assert.equal(state.businessCompleted, 0);
    assert.deepEqual(state.writes, []);
    business.resolve();
    const scan = await tapping;
    assert.equal(state.businessCompleted, 1);
    assert.equal(scan.stopRequested, false);
    assert.deepEqual(state.writes, []);
    scan.onCleanup();
    await state.flush();
    assert.equal(scan.stopRequested, true);
    assert.deepEqual(state.writes, []);
    if (order === 'stop-first') await state.finishStop();
    else await state.finishAnimation();
    assert.deepEqual(state.writes, []);
    assert.equal(state.outcome, undefined);
    if (order === 'stop-first') await state.finishAnimation();
    else await state.finishStop();
    assert.deepEqual(state.authenticated, [PIN]);
    assert.equal(state.writes.length, 1);
    assert.equal(state.writes[0].id, CARD_ID);
    assert.equal(state.writes[0].pin, PIN);
    assert.equal(state.writes[0].signal, state.readSignals[0]);
    assert.equal(state.writes[0].signal.aborted, false);
    assert.equal(
      state.outcome,
      undefined,
      'Operation must await the save result',
    );
    save.resolve();
    await state.flush();
    assert.equal(state.outcome, 'resolved');
    assert.equal(state.savedPINs[CARD_ID], PIN);
    assert.equal(state.businessCalls, 1);
    assert.deepEqual(state.errors, []);
  });

  test(`prompt: ${order} wrong cached PIN removal and PIN input wait for exit`, async () => {
    const removal = deferred();
    const state = mount({
      savedPINs: {[CARD_ID]: OLD_PIN},
      onAuthenticate: () => {
        throw wrongPIN();
      },
      onRemove: () => removal.promise,
    });
    await state.tap();
    assert.deepEqual(state.removals, []);
    assert.equal(state.inputs.length, 0);
    if (order === 'stop-first') await state.finishStop();
    else await state.finishAnimation();
    assert.deepEqual(state.removals, []);
    assert.equal(state.inputs.length, 0);
    if (order === 'stop-first') await state.finishAnimation();
    else await state.finishStop();
    assert.equal(state.removals.length, 1);
    assert.deepEqual(state.removals[0], {
      id: CARD_ID,
      expectedPIN: OLD_PIN,
      signal: state.readSignals[0],
    });
    assert.equal(
      state.inputs.length,
      0,
      'PIN input must also wait for removal',
    );
    removal.resolve();
    await state.flush();
    assert.equal(state.inputs.length, 1);
    assert.equal(state.savedPINs[CARD_ID], undefined);
    assert.equal(state.businessCalls, 0);
    state.onAuthenticate = undefined;
    await state.enterPIN();
    assert.equal(state.scans.length, 2);
    await state.tap();
    await state.finishExit();
    assert.equal(state.savedPINs[CARD_ID], PIN);
    assert.equal(state.writes.length, 1);
    assert.equal(state.businessCalls, 1);
    assert.equal(state.outcome, 'resolved');
  });

  test(`prompt: unmount after ${order} prevents a pending save`, async () => {
    const state = mount();
    await state.enterManualPIN();
    await state.tap();
    if (order === 'stop-first') await state.finishStop();
    else await state.finishAnimation();
    state.owner.unmount();
    assert.equal(state.readSignals[0].aborted, true);
    if (order === 'stop-first') await state.finishAnimation();
    else await state.finishStop();
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.notifications, []);
    assert.equal(state.businessCalls, 1);
    assert.equal(state.outcome, 'rejected');
    assert.equal(state.errors[0].code, 'CANCELLED');
  });
}

for (const failure of [cancelled, inactive, readFailed]) {
  test(`prompt: ${failure.name} read ends without scanning or retry`, async () => {
    const state = mount({
      onGet: () => {
        throw failure();
      },
    });
    await state.flush();
    assert.equal(state.gets, 1);
    assert.equal(state.scans.length, 0);
    assert.equal(state.businessCalls, 0);
    assert.equal(state.errors.length, 1);
    assert.equal(state.errors[0].code, failure().code);
    assert.equal(state.inputs.length, 0);
    assert.deepEqual(state.retryErrors, []);
    assert.equal(state.outcome, 'rejected');
  });

  test(`prompt: ${failure.name} save only warns after completed business`, async () => {
    const state = mount();
    await state.enterManualPIN();
    state.onSet = () => {
      throw Object.assign(new Error(`secret ${PIN}`), {code: failure().code});
    };
    await state.tap();
    await state.finishExit();
    assert.equal(state.businessCompleted, 1);
    assert.equal(state.businessCalls, 1);
    assert.equal(state.scans.length, 2);
    assert.equal(state.notifications.length, 1);
    assert.equal(
      state.notifications[0].message,
      'Access PIN was not saved on this device.',
    );
    assert.equal(state.notifications[0].color, 'warning');
    assert.equal(JSON.stringify(state.notifications).includes(PIN), false);
    assert.equal(state.savedPINs[CARD_ID], undefined);
    assert.deepEqual(state.errors, []);
    assert.deepEqual(state.retryErrors, []);
    assert.equal(state.outcome, 'resolved');
  });
}

test('prompt: unmount aborts preloading and rejects without accepting a late snapshot', async () => {
  const read = deferred();
  const state = mount({onGet: () => read.promise});
  await state.flush();
  assert.equal(state.scans.length, 0);
  assert.equal(state.readSignals[0].aborted, false);
  state.owner.unmount();
  assert.equal(state.readSignals[0].aborted, true);
  read.resolve({[CARD_ID]: PIN});
  await state.flush();
  assert.equal(state.scans.length, 0);
  assert.deepEqual(state.authenticated, []);
  assert.equal(state.inputs.length, 0);
  assert.equal(state.businessCalls, 0);
  assert.equal(state.outcome, 'rejected');
  assert.equal(state.errors[0].code, 'CANCELLED');
});

test('prompt: unmount during save aborts its signal and suppresses late warnings and retries', async () => {
  const state = mount();
  await state.enterManualPIN();
  const save = deferred();
  state.onSet = () => save.promise;
  await state.tap();
  await state.finishExit();
  assert.equal(state.writes.length, 1);
  const signal = state.writes[0].signal;
  assert.equal(signal.aborted, false);
  state.owner.unmount();
  assert.equal(signal.aborted, true);
  save.reject(Object.assign(new Error(`secret ${PIN}`), {code: 'CANCELLED'}));
  await state.flush();
  assert.equal(state.businessCompleted, 1);
  assert.deepEqual(state.notifications, []);
  assert.deepEqual(state.retryErrors, []);
  assert.equal(state.scans.length, 2);
  assert.equal(state.outcome, 'rejected');
  assert.equal(state.errors[0].code, 'CANCELLED');
});

test('prompt: replacing the closing presentation prevents its deferred save', async () => {
  const state = mount();
  await state.enterManualPIN();
  await state.tap();
  const previous = state.presenter.current;
  const replacementOwner = Symbol();
  state.presenter.show(replacementOwner, {
    scanning: false,
    content: 'New card',
    onDismiss() {},
  });
  await state.finishStop();
  state.presenter.remove(previous, true);
  await state.flush();
  assert.equal(state.presenter.current.owner, replacementOwner);
  assert.equal(state.presenter.current.closing, false);
  assert.deepEqual(state.writes, []);
  assert.equal(state.businessCompleted, 1);
  assert.equal(state.outcome, 'rejected');
  assert.equal(state.errors[0].code, 'CANCELLED');
});

test('prompt: an incomplete exit animation prevents a deferred save', async () => {
  const state = mount();
  await state.enterManualPIN();
  await state.tap();
  await state.finishStop();
  await state.finishAnimation(false);
  assert.deepEqual(state.writes, []);
  assert.equal(state.outcome, 'rejected');
  assert.equal(state.errors[0].code, 'CANCELLED');
});

test('prompt: native stop failure rejects without saving or retrying completed business', async () => {
  const state = mount();
  await state.enterManualPIN();
  const scan = await state.tap();
  assert.deepEqual(state.authenticated, [PIN]);
  assert.equal(state.businessCompleted, 1);
  await state.finishAnimation();
  assert.equal(state.outcome, undefined);
  const error = new IsoDepScanError('Native scan could not stop');
  scan.stop.reject(error);
  await state.flush();
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.removals, []);
  assert.deepEqual(state.retryErrors, []);
  assert.deepEqual(state.notifications, []);
  assert.equal(state.scans.length, 2);
  assert.equal(state.businessCalls, 1);
  assert.equal(state.outcome, 'rejected');
  assert.deepEqual(state.errors, [error]);
});

test("prompt: a stale authentication callback cannot remove another owner's PIN", async () => {
  const authentication = deferred();
  const state = mount({
    savedPINs: {[CARD_ID]: OLD_PIN},
    onAuthenticate: () => authentication.promise,
  });
  const tapping = state.tap();
  await state.flush();
  state.owner.unmount();
  state.savedPINs[CARD_ID] = PIN;
  authentication.reject(wrongPIN());
  await tapping;
  assert.equal(state.savedPINs[CARD_ID], PIN);
  assert.deepEqual(state.removals, []);
  assert.equal(state.inputs.length, 0);
});

test('prompt: conditional removal preserves a concurrent update and another card', async () => {
  const authentication = deferred();
  const state = mount({
    savedPINs: {[CARD_ID]: OLD_PIN, [OTHER_CARD_ID]: OLD_PIN},
    onAuthenticate: () => authentication.promise,
  });
  const tapping = state.tap();
  await state.flush();
  assert.deepEqual(state.authenticated, [OLD_PIN]);
  state.savedPINs[CARD_ID] = PIN;
  authentication.reject(wrongPIN());
  await tapping;
  assert.deepEqual(state.removals, []);
  await state.finishExit();
  assert.deepEqual(state.removals[0], {
    id: CARD_ID,
    expectedPIN: OLD_PIN,
    signal: state.readSignals[0],
  });
  assert.deepEqual(state.savedPINs, {[CARD_ID]: PIN, [OTHER_CARD_ID]: OLD_PIN});
  assert.equal(state.gets, 1);
  assert.equal(state.inputs.length, 1);
  assert.equal(state.businessCalls, 0);
  assert.deepEqual(state.writes, []);
});

test('prompt: removal failure warns without exposing the PIN and still permits manual entry', async () => {
  const state = mount({
    savedPINs: {[CARD_ID]: OLD_PIN},
    onAuthenticate: () => {
      throw wrongPIN();
    },
    onRemove: () => {
      throw new Error(`secret ${OLD_PIN}`);
    },
  });
  await state.tap();
  await state.finishExit();
  assert.equal(state.inputs.length, 1);
  assert.equal(
    state.notifications[0].message,
    'The saved Access PIN could not be removed.',
  );
  assert.equal(JSON.stringify(state.notifications).includes(OLD_PIN), false);
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.retryErrors, []);
});

test('prompt: standby starts after preloading and uses the card ID rather than Safe ID', async () => {
  const read = deferred();
  const state = mount({onGet: () => read.promise});
  await state.flush();
  assert.equal(state.gets, 1);
  assert.equal(state.scans.length, 0);
  read.resolve(Object.freeze({[CARD_ID]: PIN, '05': OLD_PIN}));
  await state.flush();
  assert.equal(state.scans.length, 1);
  await state.tap();
  assert.deepEqual(state.authenticated, [PIN]);
  assert.equal(state.businessCompleted, 1);
  assert.equal(state.outcome, undefined);
  await state.finishExit();
  assert.equal(state.gets, 1);
  assert.equal(state.outcome, 'resolved');
});

test("prompt: retry waits for stop and animation then uses each card's original snapshot PIN", async () => {
  const state = mount({savedPINs: {[CARD_ID]: PIN, [OTHER_CARD_ID]: OLD_PIN}});
  state.onBusiness = () => {
    if (state.businessCalls === 1) throw new Error('Retry card operation');
  };
  await state.tap();
  assert.equal(state.scans.length, 1);
  assert.deepEqual(state.retryErrors, []);
  await state.finishAnimation();
  assert.equal(state.scans.length, 1);
  assert.deepEqual(state.retryErrors, []);
  await state.finishStop();
  assert.equal(state.scans.length, 2);
  assert.equal(state.retryErrors.length, 1);
  state.cardId = OTHER_CARD_ID;
  state.savedPINs[OTHER_CARD_ID] = PIN;
  await state.tap();
  await state.finishExit();
  assert.deepEqual(state.authenticated, [PIN, OLD_PIN]);
  assert.equal(state.gets, 1);
  assert.equal(state.businessCalls, 2);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.removals, []);
  assert.equal(state.inputs.length, 0);
  assert.equal(state.outcome, 'resolved');
});

test('prompt: a scan lifecycle error discards a pending save and never retries business', async () => {
  const state = mount();
  await state.enterManualPIN();
  const scan = await state.tap({cleanup: false});
  scan.onError(new IsoDepScanError('Native scan stopped'));
  scan.onCleanup();
  await state.flush();
  await state.finishExit();
  assert.deepEqual(state.writes, []);
  assert.equal(state.businessCompleted, 1);
  assert.deepEqual(state.retryErrors, []);
  assert.equal(state.scans.length, 2);
  assert.equal(state.outcome, 'rejected');
  assert.ok(state.errors[0] instanceof IsoDepScanError);
});

test('prompt: auth false never reads or stores a Safe PIN used by the business action', async () => {
  const safePIN = 'Safe PIN 1';
  const state = mount({
    auth: false,
    onBusiness: applet => applet.authenticate({pin: safePIN}),
  });
  await state.tap();
  assert.equal(state.gets, 0);
  assert.deepEqual(state.readSignals, []);
  assert.deepEqual(state.authenticated, [safePIN]);
  assert.equal(state.businessCompleted, 1);
  await state.finishExit();
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.removals, []);
  assert.equal(state.inputs.length, 0);
  assert.equal(state.outcome, 'resolved');
});
