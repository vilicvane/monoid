import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {
  MonoidCardError,
  MonoidWrongCardError,
} from '../.bld/app/@lib/monoid/card-error.js';

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
mock.module('lucide-react', {namedExports: {X: 'x'}});
mock.module('../.bld/app/@lib/render-icon.js', {
  namedExports: {renderIcon: icon => icon},
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
class AppletISOError extends Error {
  constructor(note, sw, data) {
    super(note);
    this.sw = sw;
    this.data = data;
  }
}
class AppletNotFoundError extends AppletISOError {
  constructor() {
    super('Applet not found', 0x6a82, new Uint8Array());
  }
}
mock.module('../.bld/app/@lib/applet.js', {
  namedExports: {AppletISOError, AppletNotFoundError},
});
class IsoDepScanError extends Error {}
mock.module('../.bld/app/@lib/isodep.js', {
  namedExports: {IsoDepScanError},
});
mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {
    MonoidCardError,
    MonoidWrongCardError,
    MonoidAppletInvalidPINError: {is: source => source?.code === 'INVALID_PIN'},
    MonoidAppletHelloWithSafe: {
      satisfies: hello => {
        assert.ok(hello.safe);
        return hello;
      },
    },
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
const {useMonoidScanPrompt, MonoidScanRedirectError} = await import(
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
const tagLost = () => Object.assign(new Error('Tag lost'), {code: 'TAG_LOST'});

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
    helloRequests: [],
    writes: [],
    removals: [],
    businessCalls: 0,
    businessCompleted: 0,
    navigations: [],
    exitedTokens: new Set(),
    ...overrides,
  };
  state.presenter = new MonoidScanPromptPresenter();
  state.toast = options => state.notifications.push(options);
  state.business = async (applet, _setContent, hello) => {
    state.businessCalls++;
    state.businessHello = hello;
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
    router: {
      safe: {
        installApplet: {
          $replace: () => state.navigations.push({route: 'installApplet'}),
        },
        setupCard: options => ({
          $push: () => state.navigations.push({route: 'setupCard', options}),
        }),
      },
    },
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
      standby(
        callback,
        onError,
        onCleanup,
        onConnectionChange,
        waitForRemoval,
      ) {
        assert.ok(
          state.scans.every(scan => scan.stopFinished),
          'A previous native scan must finish stopping before another starts',
        );
        const scan = {
          callback,
          onError,
          onCleanup,
          onConnectionChange,
          waitForRemoval,
          stopRequested: false,
          stopFinished: false,
          stop: deferred(),
        };
        state.scans.push(scan);
        return () => {
          scan.stopRequested = true;
          scan.onConnectionChange?.(false);
          return scan.stop.promise;
        };
      },
    },
  };
  state.applet = {
    async hello(request) {
      state.helloRequests.push(request);
      await state.onHello?.();

      return {
        version: 0,
        id: new Uint8Array(Buffer.from(state.cardId, 'hex')),
        features: {curves: []},
        pin: state.helloPIN ?? 5,
        ...(request.safe && {
          safe: {
            id: new Uint8Array([5]),
            publicKey: new Uint8Array(65),
            pin: 5,
            unlocked: true,
          },
        }),
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
    return useMonoidScanPrompt({
      safe: state.safe,
      ensureSetup: state.ensureSetup,
      auth: state.auth,
      retryOnError: true,
    });
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
    scan.onConnectionChange?.(true);
    try {
      await scan.callback(state.applet);
    } catch (error) {
      scan.onError(error);
    }
    scan.callbackReturned = true;
    scan.waitingForRemoval = scan.waitForRemoval();
    scan.onConnectionChange?.(false);
    if (cleanup && !scan.stopRequested) scan.onCleanup?.();
    await state.flush();
    return scan;
  };
  state.missingApplet = async () => {
    await state.flush();
    const scan = state.scans.at(-1);
    scan.presentationToken = state.presenter.current.token;
    scan.onConnectionChange(true);
    scan.onError(new AppletNotFoundError());
    scan.waitingForRemoval = scan.waitForRemoval();
    scan.onConnectionChange(false);
    scan.onCleanup();
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

test('prompt: scan feedback follows the connection before greeting and before cleanup', async () => {
  const state = mount({auth: false});
  await state.flush();
  const scan = state.scans.at(-1);
  assert.equal(state.presenter.current.scanning, false);

  scan.onConnectionChange(true);
  await state.flush();
  assert.equal(state.presenter.current.scanning, true);
  assert.equal(state.businessCalls, 0);

  scan.onConnectionChange(false);
  await state.flush();
  assert.equal(state.presenter.current.scanning, false);
  assert.equal(scan.stopRequested, false);
  assert.equal(state.presenter.current.closing, false);
});

test('prompt: late connection events cannot restart feedback during exit', async () => {
  const state = mount({auth: false});
  const scan = await state.tap();
  assert.equal(state.presenter.current.closing, true);

  scan.onConnectionChange(true);
  await state.flush();
  assert.equal(state.presenter.current.closing, true);
  await state.finishExit();
  assert.equal(state.outcome, 'resolved');
});

test('prompt: a known card error stays visible until removal without restarting or a duplicate toast', async () => {
  const failure = new MonoidCardError('Account not on this card');
  const state = mount({
    auth: false,
    onBusiness: () => {
      throw failure;
    },
  });
  const scan = await state.tap({cleanup: false});
  const token = state.presenter.current.token;

  assert.equal(scan.waitingForRemoval, true);
  assert.equal(scan.stopRequested, false);
  assert.equal(state.presenter.current.closing, false);
  assert.equal(state.presenter.current.scanning, false);
  assert.equal(state.presenter.current.error, true);
  assert.match(
    JSON.stringify(state.presenter.current.content),
    /Account not on this card/,
  );
  assert.equal(state.presenter.current.content, failure.message);
  assert.deepEqual(state.retryErrors, []);

  scan.onConnectionChange(false);
  await state.flush();
  assert.equal(state.presenter.current.token, token);
  assert.equal(state.presenter.current.error, true);
  assert.equal(state.scans.length, 1);
  assert.equal(state.businessCalls, 1);

  scan.onCleanup();
  await state.flush();
  await state.finishExit();
  assert.equal(state.scans.length, 2);
  assert.equal(state.presenter.current.error, false);
  assert.deepEqual(state.retryErrors, []);
});

test('prompt: wrong card highlights the expected card ID', async () => {
  const state = mount({
    auth: false,
    onBusiness: () => {
      throw new MonoidWrongCardError('1234abcd');
    },
  });
  const scan = await state.tap({cleanup: false});

  assert.equal(scan.waitingForRemoval, true);
  assert.equal(state.presenter.current.error, true);
  assert.deepEqual(state.presenter.current.content, {
    type: 'fragment',
    props: {
      children: [
        'Wrong card, scan',
        ' ',
        {type: 'span', props: {children: '1234abcd'}},
      ],
    },
  });
  assert.deepEqual(state.retryErrors, []);
});

test('prompt: missing PIN exits without waiting for removal and prompts after cleanup', async () => {
  const state = mount();
  const scan = await state.tap();

  assert.equal(scan.waitingForRemoval, false);
  assert.equal(scan.stopRequested, true);
  assert.equal(state.presenter.current.closing, true);
  assert.equal(state.presenter.current.error, false);
  assert.equal(state.inputs.length, 0);
  assert.equal(state.authenticated.length, 0);

  await state.finishStop();
  assert.equal(state.inputs.length, 0);
  await state.finishAnimation();
  assert.equal(state.inputs.length, 1);
});

test('prompt: successful operations exit without waiting for removal', async () => {
  const state = mount({auth: false});
  const scan = await state.tap();

  assert.equal(scan.waitingForRemoval, false);
  assert.equal(state.presenter.current.closing, true);
  await state.finishExit();
  assert.equal(state.outcome, 'resolved');
});

test('prompt: blocked access PIN has a specific error and waits for removal', async () => {
  const state = mount({
    savedPINs: {[CARD_ID]: PIN},
    onAuthenticate: () => {
      throw new CBORAppletError({code: 'INVALID_PIN', tries: 0});
    },
  });
  const scan = await state.tap({cleanup: false});

  assert.equal(scan.waitingForRemoval, true);
  assert.equal(state.presenter.current.content, 'Access PIN blocked');
  assert.equal(state.presenter.current.error, true);
  assert.equal(state.inputs.length, 0);
  assert.equal(state.authenticated.length, 1);
  assert.deepEqual(state.retryErrors, []);
});

test('prompt: an interrupted removal wait cancels the pending PIN flow', async () => {
  const state = mount();
  const scan = await state.tap({cleanup: false});
  scan.onError(cancelled());
  scan.onCleanup();
  await state.flush();
  await state.finishExit();

  assert.equal(state.outcome, 'rejected');
  assert.equal(state.errors[0].code, 'CANCELLED');
  assert.equal(state.inputs.length, 0);
  assert.equal(state.scans.length, 1);
});

test('prompt: dismissing while waiting for removal cancels without retry', async () => {
  const state = mount({
    auth: false,
    onBusiness: () => {
      throw new MonoidCardError('Wrong card');
    },
  });
  const scan = await state.tap({cleanup: false});
  state.presenter.current.onDismiss();
  await state.flush();

  assert.equal(scan.stopRequested, true);
  assert.equal(state.errors[0].code, 'CANCELLED');
  scan.onCleanup();
  await state.finishExit();
  assert.equal(state.scans.length, 1);
  assert.deepEqual(state.retryErrors, []);
});

for (const order of ['stop-first', 'animation-first']) {
  test(`prompt: missing applet waits for ${order} cleanup then redirects once without retry`, async () => {
    const state = mount({auth: false, safe: true});
    const scan = await state.missingApplet();

    assert.equal(scan.stopRequested, true);
    assert.equal(state.presenter.current.closing, true);
    assert.deepEqual(state.navigations, []);
    assert.equal(state.outcome, undefined);
    if (order === 'stop-first') await state.finishStop();
    else await state.finishAnimation();
    assert.deepEqual(state.navigations, []);
    assert.equal(state.outcome, undefined);
    if (order === 'stop-first') await state.finishAnimation();
    else await state.finishStop();
    scan.onCleanup();
    await state.flush();

    assert.deepEqual(state.navigations, [{route: 'installApplet'}]);
    assert.equal(state.outcome, 'rejected');
    assert.equal(state.errors.length, 1);
    assert.ok(state.errors[0] instanceof MonoidScanRedirectError);
    assert.equal(isCredentialRequestCancelled(state.errors[0]), true);
    assert.equal(state.presenter.current, undefined);
    assert.equal(state.scans.length, 1);
    assert.equal(state.businessCalls, 0);
    assert.deepEqual(state.authenticated, []);
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.notifications, []);
    assert.deepEqual(state.retryErrors, []);
  });

  test(`prompt: leaving during ${order} cleanup prevents an applet-install redirect`, async () => {
    const state = mount({auth: false, safe: true});
    await state.missingApplet();
    if (order === 'stop-first') await state.finishStop();
    else await state.finishAnimation();
    state.owner.unmount();
    if (order === 'stop-first') await state.finishAnimation();
    else await state.finishStop();

    assert.deepEqual(state.navigations, []);
    assert.equal(state.outcome, 'rejected');
    assert.equal(state.errors[0].code, 'CANCELLED');
    assert.equal(state.errors[0] instanceof MonoidScanRedirectError, false);
    assert.equal(state.scans.length, 1);
    assert.equal(state.businessCalls, 0);
  });
}

test('prompt: failed native cleanup prevents an applet-install redirect', async () => {
  const state = mount({auth: false, safe: true});
  const scan = await state.missingApplet();
  await state.finishAnimation();
  const failure = new Error('Native scan could not stop');
  scan.stop.reject(failure);
  await state.flush();

  assert.deepEqual(state.navigations, []);
  assert.deepEqual(state.errors, [failure]);
  assert.equal(state.outcome, 'rejected');
  assert.equal(state.scans.length, 1);
  assert.equal(state.businessCalls, 0);
  assert.deepEqual(state.retryErrors, []);
});

test('prompt: a business command returning 6a82 does not redirect to applet installation', async () => {
  const failure = new AppletISOError(
    'Record not found',
    0x6a82,
    new Uint8Array(),
  );
  const state = mount({
    auth: false,
    onBusiness: () => {
      throw failure;
    },
  });
  await state.tap();
  await state.finishExit();

  assert.deepEqual(state.navigations, []);
  assert.deepEqual(state.retryErrors, [failure]);
  assert.equal(state.scans.length, 2);
  assert.equal(state.businessCalls, 1);
  assert.equal(state.outcome, undefined);
});

test('prompt: card setup uses the same silent redirect outcome after exit', async () => {
  const state = mount({auth: false, helloPIN: false, safe: true});
  await state.tap();
  assert.deepEqual(state.navigations, []);
  await state.finishExit();

  assert.equal(state.navigations.length, 1);
  assert.equal(state.navigations[0].route, 'setupCard');
  assert.equal(state.navigations[0].options.id, CARD_ID);
  assert.equal(state.navigations[0].options.pin, false);
  assert.ok(state.errors[0] instanceof MonoidScanRedirectError);
  assert.equal(isCredentialRequestCancelled(state.errors[0]), true);
  assert.equal(state.outcome, 'rejected');
  assert.equal(state.businessCalls, 0);
  assert.equal(state.scans.length, 1);
  assert.deepEqual(state.notifications, []);
  assert.deepEqual(state.retryErrors, []);
  assert.deepEqual(state.helloRequests, [{safe: true}]);
});

for (const safe of [undefined, false, true]) {
  test(`prompt: Safe metadata is requested only when enabled (${safe})`, async () => {
    const state = mount({safe, savedPINs: {[CARD_ID]: PIN}});
    await state.tap();
    await state.finishExit();

    assert.deepEqual(state.helloRequests, [safe ? {safe: true} : {}]);
    assert.equal(!!state.businessHello.safe, !!safe);
    assert.equal(state.outcome, 'resolved');
    assert.deepEqual(state.authenticated, [PIN]);
  });
}

for (const missingApplet of [false, true]) {
  test(`prompt: ordinary operations stop on an uninitialized card (${missingApplet ? 'no applet' : 'no PIN'})`, async () => {
    const state = mount({helloPIN: false, savedPINs: {[CARD_ID]: PIN}});
    if (missingApplet) await state.missingApplet();
    else await state.tap();

    assert.deepEqual(state.notifications, []);
    await state.finishStop();
    assert.deepEqual(state.notifications, []);
    await state.finishAnimation();

    assert.deepEqual(state.helloRequests, missingApplet ? [] : [{}]);
    assert.equal(state.scans.length, 1);
    assert.equal(state.businessCalls, 0);
    assert.equal(state.inputs.length, 0);
    assert.deepEqual(state.authenticated, []);
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.navigations, []);
    assert.deepEqual(state.retryErrors, []);
    assert.equal(state.outcome, 'rejected');
    assert.equal(isCredentialRequestCancelled(state.errors[0]), true);
    assert.equal(state.notifications.length, 1);
    assert.equal(state.notifications[0].message, 'Initialize card from Safe');
  });
}

test('prompt: setup can operate on an uninitialized card without requesting Safe metadata', async () => {
  const state = mount({auth: false, ensureSetup: false, helloPIN: false});
  await state.tap();
  await state.finishExit();

  assert.deepEqual(state.helloRequests, [{}]);
  assert.equal(state.outcome, 'resolved');
  assert.equal(state.businessCalls, 1);
  assert.deepEqual(state.notifications, []);
  assert.deepEqual(state.navigations, []);
});

for (const [phase, callback] of [
  ['hello', 'onHello'],
  ['authentication', 'onAuthenticate'],
  ['business', 'onBusiness'],
]) {
  test(`prompt: tag lost during ${phase} closes silently and cancels after cleanup`, async () => {
    const state = mount({
      savedPINs: {[CARD_ID]: PIN},
      [callback]: () => {
        throw tagLost();
      },
    });
    const scan = await state.tap();

    assert.equal(scan.stopRequested, true);
    assert.equal(state.presenter.current.closing, true);
    assert.equal(state.outcome, undefined);
    await state.finishStop();
    assert.equal(state.outcome, undefined, 'Cancellation must wait for exit');
    await state.finishAnimation();

    assert.equal(state.presenter.current, undefined);
    assert.equal(state.outcome, 'rejected');
    assert.equal(state.errors.length, 1);
    assert.equal(state.errors[0].code, 'CANCELLED');
    assert.equal(isCredentialRequestCancelled(state.errors[0]), true);
    assert.equal(state.scans.length, 1);
    assert.equal(state.businessCompleted, 0);
    assert.equal(state.businessCalls, phase === 'business' ? 1 : 0);
    assert.equal(state.inputs.length, 0);
    assert.deepEqual(state.notifications, []);
    assert.deepEqual(state.retryErrors, []);
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.removals, []);
    assert.equal(state.savedPINs[CARD_ID], PIN);
  });
}

test('prompt: tag lost discards a PIN awaiting storage after successful authentication', async () => {
  const state = mount();
  await state.enterManualPIN();
  state.onBusiness = () => {
    throw tagLost();
  };
  await state.tap();
  assert.deepEqual(state.authenticated, [PIN]);
  await state.finishExit('animation-first');

  assert.equal(state.outcome, 'rejected');
  assert.equal(state.errors[0].code, 'CANCELLED');
  assert.equal(state.businessCompleted, 0);
  assert.equal(state.scans.length, 2);
  assert.equal(state.savedPINs[CARD_ID], undefined);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.removals, []);
  assert.deepEqual(state.notifications, []);
  assert.deepEqual(state.retryErrors, []);
});

test('prompt: native stop failure takes priority over tag-lost cancellation', async () => {
  const state = mount({
    auth: false,
    onBusiness: () => {
      throw tagLost();
    },
  });
  const scan = await state.tap();
  await state.finishAnimation();
  assert.equal(state.outcome, undefined);
  const failure = new Error('Native stop failed');
  scan.stop.reject(failure);
  await state.flush();

  assert.deepEqual(state.errors, [failure]);
  assert.equal(isCredentialRequestCancelled(state.errors[0]), false);
  assert.equal(state.outcome, 'rejected');
  assert.equal(state.scans.length, 1);
  assert.deepEqual(state.notifications, []);
  assert.deepEqual(state.retryErrors, []);
  assert.deepEqual(state.writes, []);
});

for (const code of [undefined, 'IO_ERROR']) {
  test(`prompt: tag-lost text with code ${code} remains an ordinary retryable error`, async () => {
    const failure = Object.assign(new Error('Tag lost'), {code});
    const state = mount({
      auth: false,
      onBusiness: () => {
        throw failure;
      },
    });
    await state.tap();
    await state.finishExit();

    assert.deepEqual(state.retryErrors, [failure]);
    assert.deepEqual(state.errors, []);
    assert.equal(state.scans.length, 2);
    assert.equal(state.presenter.current.closing, false);
    assert.equal(state.outcome, undefined);
  });
}

test('prompt: a lifecycle error with tag-lost cause is not silently cancelled', async () => {
  const failure = new IsoDepScanError('Native cleanup failed', {
    cause: tagLost(),
  });
  const state = mount({auth: false});
  await state.flush();
  const scan = state.scans.at(-1);
  scan.onError(failure);
  scan.onCleanup();
  await state.flush();
  await state.finishExit();

  assert.deepEqual(state.errors, [failure]);
  assert.equal(isCredentialRequestCancelled(failure), false);
  assert.equal(state.outcome, 'rejected');
  assert.equal(state.scans.length, 1);
  assert.equal(state.businessCalls, 0);
  assert.deepEqual(state.retryErrors, []);
});

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
