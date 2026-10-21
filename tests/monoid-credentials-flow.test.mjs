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
let platform = 'android';
const mounted = [];
mock.module('@capacitor/core', {
  namedExports: {Capacitor: {getPlatform: () => platform}},
});
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
mock.module('lucide-react', {namedExports: {X: 'x', Bug: 'bug'}});
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
      const show = hooks.useCallback(options => {
        const input = deferred();
        input.options = options;
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
mock.module('../.bld/app/@lib/global-platform/card-information.js', {
  namedExports: {
    async readCardInformation(sessionId) {
      const state = fixture;
      const scan = state.scans.at(-1);
      assert.equal(scan.stopRequested, false);
      assert.notEqual(scan.callbackReturned, true);
      state.cardInformationReads.push(sessionId);
      return state.onReadCardInformation
        ? state.onReadCardInformation(sessionId)
        : state.cardInformation;
    },
  },
});
const MonoidAppletHello = {
  satisfies: hello => {
    assert.ok(hello.id);
    assert.ok(hello.publicKey);
    assert.ok(hello.pins);
    return hello;
  },
};
mock.module('../.bld/app/@lib/monoid/monoid-applet.js', {
  namedExports: {MonoidAppletHello},
});
const {initializeMonoidCard} = await import(
  '../.bld/app/@lib/monoid/initialize-card.js'
);
mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {
    initializeMonoidCard,
    MonoidCardError,
    MonoidWrongCardError,
    MonoidAppletInvalidPINError: {is: source => source?.code === 'INVALID_PIN'},
    MonoidAppletHello,
  },
});
const {MonoidPINSession, isCredentialRequestCancelled} = await import(
  '../.bld/app/@services/monoid-credentials-store.js'
);
mock.module('../.bld/app/@services/index.js', {
  namedExports: {isCredentialRequestCancelled},
});

const {MonoidScanPromptPresenter} = await import(
  '../.bld/app/@services/monoid-scan-prompt-presenter.js'
);
const {ErrorService} = await import('../.bld/app/@services/error-service.js');
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
  platform = 'android';
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
const SECRET_PIN = 'Secret PIN 1';
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
    retryOnError: true,
    cardId: CARD_ID,
    savedPINs: {},
    scans: [],
    inputs: [],
    notifications: [],
    errors: [],
    retryErrors: [],
    presentedErrors: [],
    gets: 0,
    unlocks: 0,
    disposals: 0,
    readSignals: [],
    authenticated: [],
    authenticationRequests: [],
    cardPINWrites: [],
    cardCommands: [],
    helloRequests: [],
    writes: [],
    removals: [],
    businessCalls: 0,
    businessCompleted: 0,
    navigations: [],
    cardInformationReads: [],
    cardInformation: {
      cardManagerAid: 'a000000151000000',
      globalPlatformVersion: '2.3',
      secureChannels: ['SCP03'],
    },
    exitedTokens: new Set(),
    identityPublicKey: new Uint8Array(65),
    ...overrides,
  };
  state.presenter = new MonoidScanPromptPresenter();
  state.toast = options => state.notifications.push(options);
  state.business = async (applet, _setContent, hello) => {
    state.businessCalls++;
    state.businessHello = hello;
    const result = await state.onBusiness?.(applet, _setContent, hello);
    state.businessCompleted++;
    return result;
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
      cardApplets: options => ({
        $replace: () => {
          assertMutationReady();
          state.navigations.push({route: 'cardApplets', options});
        },
      }),
    },
    monoidScanPromptPresenter: state.presenter,
    errorService: state.errorService ?? {
      markPresented: error => {
        const presented =
          typeof error === 'object' && error !== null
            ? error
            : new Error(String(error));
        state.presentedErrors.push(presented);
        return presented;
      },
      catch: promise => promise.catch(error => state.retryErrors.push(error)),
    },
    monoidCredentialsStore: {
      createPINSession() {
        return new MonoidPINSession(this);
      },
      async authenticate() {
        state.unlocks++;
        return {
          [Symbol.asyncDispose]: async () => {
            state.disposals++;
            await state.onDispose?.();
          },
        };
      },
      async getPINs(signal, getAccess) {
        await getAccess?.();
        state.gets++;
        state.readSignals.push(signal);
        return state.onGet
          ? state.onGet(signal)
          : Object.freeze({...state.savedPINs});
      },
      async setPIN(id, pin, signal, _snapshot, getAccess) {
        await getAccess?.();
        assertMutationReady();
        state.writes.push({id, pin, signal});
        await state.onSet?.(signal);
        state.savedPINs[id] = pin;
        return Object.freeze({...state.savedPINs});
      },
      async removePIN(id, expectedPIN, signal, _snapshot, getAccess) {
        await getAccess?.();
        assertMutationReady();
        state.removals.push({id, expectedPIN, signal});
        await state.onRemove?.(signal);
        if (expectedPIN === undefined || state.savedPINs[id] === expectedPIN) {
          delete state.savedPINs[id];
        }
        return Object.freeze({...state.savedPINs});
      },
    },
    monoidApplet: {
      standby(
        callback,
        onError,
        onCleanup,
        onConnectionChange,
        getCloseOptions,
        onNotFound,
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
          getCloseOptions,
          onNotFound,
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
      state.cardCommands.push({command: 'hello', request});
      await state.onHello?.();

      return {
        version: 0,
        id: new Uint8Array(Buffer.from(state.cardId, 'hex')),
        publicKey: state.identityPublicKey.slice(),
        bundle: false,
        pins: {access: state.accessPIN ?? 5, secret: state.secretPIN ?? 5},
      };
    },
    async authenticate(request) {
      const {pin} = request;
      state.authenticated.push(pin);
      state.authenticationRequests.push(request);
      state.cardCommands.push({command: 'authenticate', request});
      await state.onAuthenticate?.(pin, request);
    },
    async setPIN(request) {
      state.cardPINWrites.push(request);
      state.cardCommands.push({command: 'setPIN', request});
      await state.onSetCardPIN?.(request);
      if (state.accessPIN === false) state.accessPIN = 5;
      if (request.secret) {
        state.secretPIN = 5;
      }
    },
  };
  if (state.pinSession === true) {
    state.pinSession = new MonoidPINSession(
      state.entrances.monoidCredentialsStore,
    );
  }
  fixture = state;
  state.owner = new HookOwner(() => {
    fixture = state;
    return useMonoidScanPrompt({
      allowSetup: state.allowSetup,
      ensureSetup: state.ensureSetup,
      allowInstallRedirect: state.allowInstallRedirect,
      auth: state.auth,
      retryOnError: state.retryOnError,
      pinSession: state.pinSession,
    });
  });
  state.owner.flush();
  state.start = () => {
    state.outcome = undefined;
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
  };
  state.start();
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
    scan.closeOptions = scan.getCloseOptions();
    scan.waitingForRemoval = scan.closeOptions.waitForRemoval ?? false;
    scan.onConnectionChange?.(false);
    if (cleanup && !scan.stopRequested) scan.onCleanup?.();
    await state.flush();
    return scan;
  };
  state.missingApplet = async ({cleanup = true} = {}) => {
    await state.flush();
    const scan = state.scans.at(-1);
    scan.presentationToken = state.presenter.current.token;
    scan.onConnectionChange(true);
    try {
      if (scan.onNotFound) await scan.onNotFound('missing-applet-card');
      else throw new AppletNotFoundError();
    } catch (error) {
      scan.onError(error);
    }
    scan.callbackReturned = true;
    scan.closeOptions = scan.getCloseOptions();
    scan.waitingForRemoval = scan.closeOptions.waitForRemoval ?? false;
    scan.onConnectionChange(false);
    if (cleanup && !scan.stopRequested) scan.onCleanup();
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

test('prompt: native session identity clears after a result and cannot leak into the next operation', async () => {
  const state = mount({auth: false});
  await state.flush();
  const scan = state.scans.at(-1);
  assert.equal(state.presenter.current.sessionId, undefined);
  scan.presentationToken = state.presenter.current.token;
  scan.onConnectionChange(true, 'first-native-session');
  await state.flush();
  assert.equal(state.presenter.current.sessionId, 'first-native-session');
  await scan.callback(state.applet);
  scan.callbackReturned = true;
  scan.onConnectionChange(false);
  await state.flush();
  assert.equal(state.presenter.current.sessionId, undefined);
  scan.onConnectionChange(true, 'late-native-session');
  await state.flush();
  assert.equal(state.presenter.current.sessionId, undefined);
  scan.onCleanup();
  await state.flush();
  await state.finishExit();
  state.start();
  await state.flush();
  assert.equal(state.presenter.current.sessionId, undefined);
  const next = state.scans.at(-1);
  next.onConnectionChange(true, 'second-native-session');
  await state.flush();
  assert.equal(state.presenter.current.sessionId, 'second-native-session');
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

test('prompt: a known card error stays visible until removal and is marked as presented before retry', async () => {
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
  assert.deepEqual(state.presentedErrors, [failure]);
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
  assert.deepEqual(state.retryErrors, [failure]);
  assert.deepEqual(state.presentedErrors, [failure]);
  assert.deepEqual(state.notifications, []);
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

test('prompt: ordinary errors retain their identity after inline display and retry', async () => {
  const failure = new Error('Unexpected APDU response');
  const state = mount({
    auth: false,
    onBusiness: () => {
      throw failure;
    },
  });
  const scan = await state.tap({cleanup: false});
  assert.equal(state.presenter.current.content, failure.message);
  assert.deepEqual(state.presentedErrors, [failure]);
  scan.onCleanup();
  await state.flush();
  await state.finishExit();
  assert.deepEqual(state.retryErrors, [failure]);
});

for (const {targetPlatform, failure} of [
  {targetPlatform: 'android', failure: new Error('Wrong card')},
  {targetPlatform: 'android', failure: 'Unexpected card response'},
  {targetPlatform: 'ios', failure: new Error('Wrong card')},
]) {
  test(`prompt: ${targetPlatform} ${typeof failure === 'string' ? 'primitive' : 'Error'} failures are shown exactly once across the scan and error service`, async t => {
    platform = targetPlatform;
    const errorService = new ErrorService();
    const toasts = [];
    errorService.presentToast = async options => toasts.push(options);
    const mark = t.mock.method(errorService, 'markPresented');
    const log = t.mock.method(console, 'error', () => {});
    const state = mount({
      auth: false,
      retryOnError: false,
      errorService,
      onBusiness: () => {
        throw failure;
      },
    });
    errorService.catch(state.operation);
    const scan = await state.tap({cleanup: false});

    assert.equal(scan.waitingForRemoval, targetPlatform === 'android');
    assert.equal(mark.mock.callCount(), targetPlatform === 'android' ? 1 : 0);
    assert.deepEqual(toasts, []);
    if (targetPlatform === 'android') {
      assert.equal(
        state.presenter.current.content,
        failure instanceof Error ? failure.message : failure,
      );
    }

    scan.onCleanup();
    await state.flush();
    await state.finishExit();

    assert.equal(state.outcome, 'rejected');
    assert.equal(state.scans.length, 1);
    const reported = state.errors[0];
    if (failure instanceof Error) {
      assert.equal(reported, failure);
    } else {
      assert.ok(reported instanceof Error);
      assert.equal(reported.message, failure);
    }
    assert.equal(log.mock.calls[0].arguments[0], reported);
    if (targetPlatform === 'android') {
      assert.equal(mark.mock.calls[0].result, reported);
      assert.deepEqual(toasts, []);
    } else {
      assert.equal(toasts.length, 1);
      assert.equal(toasts[0].message, failure.message);
    }
  });
}

test('prompt: iOS returns errors after closing the sheet without silently reopening it', async () => {
  platform = 'ios';
  const error = new Error('Wrong card');
  const state = mount({
    auth: false,
    onBusiness: () => {
      throw error;
    },
  });
  const scan = await state.tap();
  assert.equal(scan.waitingForRemoval, false);
  assert.deepEqual(scan.closeOptions, {
    errorMessage: 'Card operation failed.',
  });
  assert.equal(scan.stopRequested, true);
  assert.deepEqual(state.presentedErrors, []);
  assert.equal(state.outcome, undefined);
  await state.finishExit();
  assert.equal(state.scans.length, 1);
  assert.equal(state.outcome, 'rejected');
  assert.equal(state.errors[0], error);
});

test('prompt: iOS dismisses the reader before asking for a missing PIN', async () => {
  platform = 'ios';
  const state = mount();
  await state.tap();
  assert.equal(state.inputs.length, 0);
  await state.finishAnimation();
  assert.equal(state.inputs.length, 0);
  await state.finishStop();
  assert.equal(state.inputs.length, 1);
});

for (const pinSource of ['saved Access', 'entered Access', 'Secret']) {
  test(`prompt: iOS marks incorrect ${pinSource} PIN as failure before input, then clears a successful retry`, async () => {
    platform = 'ios';
    const secret = pinSource === 'Secret';
    const saved = pinSource === 'saved Access';
    const state = mount({
      ...(secret && {allowSetup: true, accessPIN: false, secretPIN: 5}),
      savedPINs: saved ? {[CARD_ID]: OLD_PIN} : {},
      onAuthenticate: () => {
        throw wrongPIN();
      },
    });
    if (!saved) {
      const missingPIN = await state.tap();
      assert.deepEqual(missingPIN.closeOptions, {});
      await state.finishExit();
      await state.enterPIN(OLD_PIN);
    }
    const previousInputs = state.inputs.length;
    const scan = await state.tap();
    const errorMessage = `Incorrect ${secret ? 'Secret ' : ''}PIN, tries remaining: 4`;

    assert.deepEqual(scan.closeOptions, {errorMessage});
    assert.equal(scan.waitingForRemoval, false);
    assert.equal(state.inputs.length, previousInputs);
    assert.equal(state.businessCalls, 0);
    assert.deepEqual(state.authenticated, [OLD_PIN]);
    assert.deepEqual(state.authenticationRequests, [
      secret ? {secret: true, pin: OLD_PIN} : {pin: OLD_PIN},
    ]);
    await state.finishAnimation();
    assert.equal(state.inputs.length, previousInputs);
    await state.finishStop();
    assert.equal(state.inputs.length, previousInputs + 1);
    assert.equal(state.notifications.at(-1).message, errorMessage);
    assert.equal(state.removals.length, saved ? 1 : 0);
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.authenticated, [OLD_PIN]);

    state.onAuthenticate = undefined;
    await state.enterPIN(secret ? SECRET_PIN : PIN);
    const retry = await state.tap();
    assert.deepEqual(retry.closeOptions, {message: ''});
    await state.finishExit();
    assert.equal(state.businessCompleted, 1);
    assert.equal(state.outcome, 'resolved');
  });
}

for (const secret of [false, true]) {
  test(`prompt: iOS marks exhausted ${secret ? 'Secret' : 'Access'} PIN as failure without another attempt`, async () => {
    platform = 'ios';
    const state = mount({
      ...(secret && {allowSetup: true, accessPIN: false, secretPIN: 5}),
      savedPINs: secret ? {} : {[CARD_ID]: PIN},
      onAuthenticate: () => {
        throw new CBORAppletError({code: 'INVALID_PIN', tries: 0});
      },
    });
    if (secret) {
      await state.tap();
      await state.finishExit();
      await state.enterPIN(SECRET_PIN);
    }
    const scan = await state.tap();
    const errorMessage = `${secret ? 'Secret' : 'Access'} PIN blocked`;
    assert.deepEqual(scan.closeOptions, {errorMessage});
    assert.equal(scan.waitingForRemoval, false);
    await state.finishExit();
    assert.equal(state.errors[0].message, errorMessage);
    assert.equal(state.authenticated.length, 1);
    assert.equal(state.inputs.length, secret ? 1 : 0);
    assert.equal(state.scans.length, secret ? 2 : 1);
    assert.equal(state.businessCalls, 0);
    assert.deepEqual(state.writes, []);
  });
}

for (const [failure, errorMessage] of [
  [
    new MonoidCardError('Incorrect Secret PIN, tries remaining: 4'),
    'Incorrect Secret PIN, tries remaining: 4',
  ],
  [new MonoidCardError('Secret PIN blocked'), 'Secret PIN blocked'],
  [wrongPIN(), 'Incorrect PIN, tries remaining: 4'],
  [new CBORAppletError({code: 'INVALID_PIN', tries: 0}), 'PIN blocked'],
]) {
  test(`prompt: iOS preserves business PIN failure (${errorMessage}) after native error completion`, async () => {
    platform = 'ios';
    const state = mount({
      auth: false,
      onBusiness: () => {
        throw failure;
      },
    });
    const scan = await state.tap();
    assert.deepEqual(scan.closeOptions, {errorMessage});
    assert.equal(state.outcome, undefined);
    await state.finishExit();
    assert.deepEqual(state.errors, [failure]);
    assert.equal(state.businessCalls, 1);
    assert.equal(state.scans.length, 1);
    assert.equal(state.inputs.length, 0);
  });
}

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

for (const targetPlatform of ['ios', 'android']) {
  test(`prompt: successful operations show completion while exiting on ${targetPlatform}`, async () => {
    platform = targetPlatform;
    const state = mount({
      auth: false,
      onBusiness: (_applet, setContent) => setContent('Reading addresses 3/3'),
    });
    const scan = await state.tap();

    assert.equal(scan.waitingForRemoval, false);
    assert.deepEqual(
      scan.closeOptions,
      targetPlatform === 'ios' ? {message: ''} : {},
    );
    assert.equal(state.presenter.current.content, '');
    assert.equal(state.presenter.current.closing, true);
    await state.finishExit();
    assert.equal(state.outcome, 'resolved');
  });

  test(`prompt: an explicit success message stays visible without error styling on ${targetPlatform}`, async () => {
    platform = targetPlatform;
    const state = mount({
      auth: false,
      onBusiness: (_applet, setContent) => {
        setContent('Checking card, hold tight...');
        return {message: 'Already synced'};
      },
    });
    const scan = await state.tap({cleanup: false});

    assert.deepEqual(
      scan.closeOptions,
      targetPlatform === 'ios'
        ? {message: 'Already synced'}
        : {waitForRemoval: true},
    );
    assert.equal(state.presenter.current.content, 'Already synced');
    assert.equal(state.presenter.current.error, false);
    assert.equal(state.presenter.current.closing, false);
    if (targetPlatform === 'android') {
      assert.equal(state.presenter.current.scanning, false);
      assert.equal(scan.waitingForRemoval, true);
    }
    assert.equal(state.outcome, undefined);
    assert.deepEqual(state.presentedErrors, []);
    assert.deepEqual(state.retryErrors, []);

    scan.onCleanup();
    await state.flush();
    assert.equal(state.presenter.current.content, 'Already synced');
    assert.equal(state.presenter.current.closing, true);
    await state.finishExit();
    assert.equal(state.outcome, 'resolved');
    assert.equal(state.scans.length, 1);
  });

  test(`prompt: an empty success message keeps the normal clear-and-close behavior on ${targetPlatform}`, async () => {
    platform = targetPlatform;
    const state = mount({
      auth: false,
      onBusiness: () => ({message: ''}),
    });
    const scan = await state.tap();

    assert.equal(scan.waitingForRemoval, false);
    assert.deepEqual(
      scan.closeOptions,
      targetPlatform === 'ios' ? {message: ''} : {},
    );
    assert.equal(state.presenter.current.content, '');
    assert.equal(state.presenter.current.error, false);
    await state.finishExit();
    assert.equal(state.outcome, 'resolved');
  });
}

for (const [outcome, options, missingApplet, closeOptions = {}] of [
  ['Access PIN input', {}, false],
  [
    'Secret PIN input',
    {allowSetup: true, accessPIN: false, secretPIN: false},
    false,
  ],
  ['install redirect', {auth: false, allowInstallRedirect: true}, true],
  [
    'uninitialized card',
    {auth: false, accessPIN: false},
    false,
    {errorMessage: 'Initialize card from Safe'},
  ],
  [
    'operation failure',
    {
      auth: false,
      onBusiness: () => {
        throw readFailed();
      },
    },
    false,
    {errorMessage: 'Card operation failed.'},
  ],
  [
    'tag loss',
    {
      auth: false,
      onBusiness: () => {
        throw tagLost();
      },
    },
    false,
  ],
]) {
  test(`prompt: ${outcome} does not clear the iOS message as a success`, async () => {
    platform = 'ios';
    const state = mount(options);
    const scan = missingApplet
      ? await state.missingApplet()
      : await state.tap();

    assert.deepEqual(scan.closeOptions, closeOptions);
    assert.notEqual(state.presenter.current.content, '');
    assert.equal(state.presenter.current.closing, true);
    await state.finishExit();
    assert.notEqual(state.outcome, 'resolved');
  });
}

for (const cancellation of ['dismiss', 'unmount']) {
  test(`prompt: ${cancellation} before a late callback resolves does not claim iOS completion`, async () => {
    platform = 'ios';
    const reading = deferred();
    const state = mount({auth: false, onBusiness: () => reading.promise});
    const tapping = state.tap();
    await state.flush();
    assert.equal(state.businessCalls, 1);

    if (cancellation === 'dismiss') state.presenter.current.onDismiss();
    else state.owner.unmount();
    await state.flush();
    reading.resolve();
    const scan = await tapping;

    assert.deepEqual(scan.closeOptions, {});
    assert.notEqual(state.presenter.current.content, '');
    await state.finishExit();
    assert.equal(state.outcome, 'rejected');
    assert.equal(state.errors[0].code, 'CANCELLED');
  });
}

test('prompt: a page PIN session unlocks once for multiple destination scans', async () => {
  const state = mount({
    pinSession: true,
    savedPINs: {[CARD_ID]: PIN, [OTHER_CARD_ID]: OLD_PIN},
  });
  await state.tap();
  await state.finishExit();
  state.cardId = OTHER_CARD_ID;
  state.start();
  await state.tap();
  await state.finishExit();

  assert.deepEqual(state.authenticated, [PIN, OLD_PIN]);
  assert.equal(state.gets, 1);
  assert.equal(state.outcome, 'resolved');
  state.pinSession.clear();
});

test('prompt: a verified manual PIN survives tag loss and a new scan on the same page', async () => {
  const state = mount({
    pinSession: true,
    onBusiness: () => {
      throw tagLost();
    },
  });
  await state.enterManualPIN();
  await state.tap();
  await state.finishExit();
  assert.equal(state.outcome, 'rejected');
  assert.equal(state.writes.length, 0);

  state.onBusiness = undefined;
  state.start();
  await state.tap();
  await state.finishExit();
  assert.equal(state.outcome, 'resolved');
  assert.deepEqual(state.authenticated, [PIN, PIN]);
  assert.equal(state.gets, 1);
  assert.equal(state.inputs.length, 1);
  assert.equal(state.writes.length, 1);
  assert.ok(state.savedPINs[CARD_ID] === PIN);
  assert.equal(state.pinSession.hasUnsavedPIN(CARD_ID, PIN), false);
  state.pinSession.clear();
});

test('prompt: an unsaved verified PIN is saved after a later successful scan', async () => {
  const state = mount({
    pinSession: true,
    onSet: () => {
      throw readFailed();
    },
  });
  await state.enterManualPIN();
  await state.tap();
  await state.finishExit();
  assert.equal(state.outcome, 'resolved');
  assert.equal(state.writes.length, 1);
  assert.equal(state.savedPINs[CARD_ID], undefined);
  assert.equal(state.pinSession.hasUnsavedPIN(CARD_ID, PIN), true);

  state.onSet = undefined;
  state.start();
  await state.tap();
  await state.finishExit();
  assert.equal(state.outcome, 'resolved');
  assert.equal(state.writes.length, 2);
  assert.equal(state.inputs.length, 1);
  assert.equal(state.gets, 1);
  assert.ok(state.savedPINs[CARD_ID] === PIN);
  assert.equal(state.pinSession.hasUnsavedPIN(CARD_ID, PIN), false);
  state.pinSession.clear();
});

test('prompt: a bad cached PIN is not retried after removal fails and the user starts another scan', async () => {
  const state = mount({
    pinSession: true,
    savedPINs: {[CARD_ID]: OLD_PIN},
    onAuthenticate: () => {
      throw wrongPIN();
    },
    onRemove: () => {
      throw readFailed();
    },
  });
  await state.tap();
  await state.finishExit();
  state.inputs.at(-1).resolve(undefined);
  await state.flush();
  assert.equal(state.outcome, 'rejected');

  state.start();
  await state.tap();
  await state.finishExit();
  assert.deepEqual(state.authenticated, [OLD_PIN]);
  assert.equal(state.inputs.length, 2);
  assert.equal(state.gets, 1);
  state.pinSession.clear();
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

test('prompt: missing applet reads card information on the open connection before cleanup', async () => {
  const reading = deferred();
  const state = mount({
    auth: false,
    allowInstallRedirect: true,
    onReadCardInformation: () => reading.promise,
  });
  const tapping = state.missingApplet();
  await state.flush();
  const scan = state.scans.at(-1);

  assert.deepEqual(state.cardInformationReads, ['missing-applet-card']);
  assert.equal(scan.stopRequested, false);
  assert.equal(scan.callbackReturned, undefined);
  assert.equal(state.presenter.current.closing, false);
  assert.equal(
    state.presenter.current.content,
    'Reading card information, hold tight...',
  );
  assert.deepEqual(state.navigations, []);

  reading.resolve(state.cardInformation);
  await tapping;
  assert.equal(scan.callbackReturned, true);
  assert.equal(scan.waitingForRemoval, false);
  assert.equal(scan.stopRequested, true);
  assert.deepEqual(state.navigations, []);
  await state.finishExit();
  assert.deepEqual(state.navigations, [
    {
      route: 'cardApplets',
      options: {cardInformation: state.cardInformation, returnTo: 'safe'},
    },
  ]);
});

for (const cancellation of ['dismiss', 'unmount']) {
  test(`prompt: ${cancellation} during card information read prevents a late install redirect`, async () => {
    const reading = deferred();
    const state = mount({
      auth: false,
      allowInstallRedirect: true,
      onReadCardInformation: () => reading.promise,
    });
    const tapping = state.missingApplet();
    await state.flush();
    assert.deepEqual(state.cardInformationReads, ['missing-applet-card']);
    if (cancellation === 'dismiss') state.presenter.current.onDismiss();
    else state.owner.unmount();
    await state.flush();

    assert.equal(state.scans[0].stopRequested, true);
    assert.equal(state.outcome, 'rejected');
    assert.equal(state.errors[0].code, 'CANCELLED');
    reading.resolve(state.cardInformation);
    await tapping;
    await state.finishExit();

    assert.deepEqual(state.navigations, []);
    assert.deepEqual(state.notifications, []);
    assert.deepEqual(state.retryErrors, []);
    assert.equal(state.scans.length, 1);
    assert.equal(state.businessCalls, 0);
  });
}

test('prompt: card information read failure does not navigate or reuse incomplete metadata', async () => {
  const failure = new Error('Card information read failed');
  const state = mount({
    auth: false,
    allowInstallRedirect: true,
    onReadCardInformation: () => {
      throw failure;
    },
  });
  await state.missingApplet();
  await state.finishExit();

  assert.deepEqual(state.cardInformationReads, ['missing-applet-card']);
  assert.deepEqual(state.navigations, []);
  assert.deepEqual(state.retryErrors, [failure]);
  assert.equal(state.businessCalls, 0);
  assert.equal(state.scans.length, 2);
});

for (const order of ['stop-first', 'animation-first']) {
  test(`prompt: missing applet redirects after ${order} cleanup without waiting for card removal`, async () => {
    const state = mount({
      auth: false,
      allowSetup: true,
      allowInstallRedirect: true,
    });
    const scan = await state.missingApplet();

    assert.equal(scan.waitingForRemoval, false);
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

    assert.deepEqual(state.cardInformationReads, ['missing-applet-card']);
    assert.deepEqual(state.navigations, [
      {
        route: 'cardApplets',
        options: {cardInformation: state.cardInformation, returnTo: 'safe'},
      },
    ]);
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
    const state = mount({
      auth: false,
      allowSetup: true,
      allowInstallRedirect: true,
    });
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
  const state = mount({
    auth: false,
    allowSetup: true,
    allowInstallRedirect: true,
  });
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

for (const allowInstallRedirect of [undefined, false]) {
  test(`prompt: allowing PIN setup does not enable installation (${allowInstallRedirect})`, async () => {
    const state = mount({auth: false, allowSetup: true, allowInstallRedirect});
    const scan = await state.missingApplet({cleanup: false});
    assert.equal(scan.waitingForRemoval, true);
    assert.equal(scan.stopRequested, false);
    assert.equal(state.presenter.current.error, true);
    assert.equal(state.presenter.current.closing, false);
    assert.equal(state.presenter.current.content, 'Initialize card from Safe');
    scan.onCleanup();
    await state.flush();
    await state.finishExit();

    assert.deepEqual(state.navigations, []);
    assert.deepEqual(state.cardInformationReads, []);
    assert.equal(state.businessCalls, 0);
    assert.equal(state.outcome, 'rejected');
    assert.equal(isCredentialRequestCancelled(state.errors[0]), true);
    assert.deepEqual(state.notifications, []);
    assert.equal(state.scans.length, 1);
  });
}

test('prompt: a business command returning 6a82 does not redirect to applet installation', async () => {
  const failure = new AppletISOError(
    'Record not found',
    0x6a82,
    new Uint8Array(),
  );
  const state = mount({
    auth: false,
    allowInstallRedirect: true,
    onBusiness: () => {
      throw failure;
    },
  });
  await state.tap();
  await state.finishExit();

  assert.deepEqual(state.navigations, []);
  assert.deepEqual(state.cardInformationReads, []);
  assert.deepEqual(state.retryErrors, [failure]);
  assert.equal(state.scans.length, 2);
  assert.equal(state.businessCalls, 1);
  assert.equal(state.outcome, undefined);
});

function inputText(value) {
  if (Array.isArray(value)) return value.map(inputText).join('');
  if (typeof value === 'object' && value !== null) {
    return inputText(value.props?.children);
  }
  return value === undefined || value === null ? '' : String(value);
}

for (const order of ['stop-first', 'animation-first']) {
  test(`prompt: new card initializes inline after ${order} cleanup and resumes business`, async () => {
    const state = mount({allowSetup: true, accessPIN: false, secretPIN: false});
    const firstScan = await state.tap({cleanup: false});

    assert.equal(firstScan.waitingForRemoval, false);
    assert.equal(state.inputs.length, 0);
    assert.equal(state.businessCalls, 0);
    assert.deepEqual(state.cardPINWrites, []);
    firstScan.onCleanup();
    await state.flush();
    if (order === 'stop-first') await state.finishStop();
    else await state.finishAnimation();
    assert.equal(state.inputs.length, 0);
    if (order === 'stop-first') await state.finishAnimation();
    else await state.finishStop();

    assert.equal(state.inputs.length, 1);
    assert.equal(state.inputs[0].options.placeholder, 'Set Secret PIN');
    assert.equal(
      inputText(state.inputs[0].options.description),
      'Will be used as initial Access PIN',
    );
    assert.deepEqual(state.navigations, []);
    assert.deepEqual(state.errors, []);
    await state.enterPIN(SECRET_PIN);
    const initializedScan = await state.tap();

    assert.equal(initializedScan.waitingForRemoval, false);
    assert.deepEqual(state.cardPINWrites, [{secret: true, pin: SECRET_PIN}]);
    assert.deepEqual(state.authenticationRequests, [{pin: SECRET_PIN}]);
    assert.deepEqual(
      state.cardCommands.map(({command}) => command),
      ['hello', 'hello', 'setPIN', 'hello', 'authenticate'],
    );
    assert.equal(state.businessCalls, 1);
    assert.deepEqual(state.businessHello.pins, {access: 5, secret: 5});
    assert.deepEqual(state.writes, []);
    await state.finishExit(order);

    assert.equal(state.outcome, 'resolved');
    assert.equal(state.gets, 1);
    assert.equal(state.savedPINs[CARD_ID], SECRET_PIN);
    assert.equal(state.writes.length, 1);
    assert.deepEqual(state.navigations, []);
    assert.deepEqual(state.notifications, []);
    assert.deepEqual(state.retryErrors, []);
  });
}

test('prompt: an existing Secret PIN authorizes setting only the missing Access PIN', async () => {
  const state = mount({
    allowSetup: true,
    accessPIN: false,
    onSetCardPIN: async () => {
      await state.flush();
      assert.equal(
        state.presenter.current.content,
        'Setting Access PIN, hold tight...',
      );
    },
  });
  await state.tap();
  await state.finishExit();
  assert.equal(
    state.inputs[0].options.placeholder,
    'Enter existing Secret PIN',
  );
  await state.enterPIN(SECRET_PIN);
  await state.tap();

  assert.deepEqual(state.authenticationRequests, [
    {secret: true, pin: SECRET_PIN},
    {pin: SECRET_PIN},
  ]);
  assert.deepEqual(state.cardPINWrites, [{pin: SECRET_PIN}]);
  assert.deepEqual(
    state.cardCommands.map(({command}) => command),
    ['hello', 'hello', 'authenticate', 'setPIN', 'hello', 'authenticate'],
  );
  await state.finishExit();
  assert.equal(state.savedPINs[CARD_ID], SECRET_PIN);
  assert.equal(state.businessCompleted, 1);
  assert.deepEqual(state.navigations, []);
});

test('prompt: initializing with auth disabled still verifies and saves the newly created Access PIN', async () => {
  const state = mount({
    auth: false,
    allowSetup: true,
    accessPIN: false,
    secretPIN: false,
  });
  await state.tap();
  await state.finishExit();
  await state.enterPIN(SECRET_PIN);
  await state.tap();

  assert.equal(state.gets, 0);
  assert.deepEqual(state.authenticationRequests, [{pin: SECRET_PIN}]);
  assert.deepEqual(state.writes, []);
  await state.finishExit();
  assert.equal(state.savedPINs[CARD_ID], SECRET_PIN);
  assert.equal(state.businessCompleted, 1);
  assert.equal(state.outcome, 'resolved');
});

test('prompt: a Safe initialized between taps prompts for its existing PIN before sending credentials', async () => {
  const state = mount({allowSetup: true, accessPIN: false, secretPIN: false});
  await state.tap();
  await state.finishExit();
  await state.enterPIN(SECRET_PIN);
  state.secretPIN = 5;
  await state.tap();

  assert.deepEqual(state.authenticationRequests, []);
  assert.deepEqual(state.cardPINWrites, []);
  assert.equal(state.businessCalls, 0);
  await state.finishExit();
  assert.equal(state.inputs.length, 2);
  assert.equal(
    state.inputs[1].options.placeholder,
    'Enter existing Secret PIN',
  );
  await state.enterPIN(OLD_PIN);
  await state.tap();
  await state.finishExit();
  assert.deepEqual(state.authenticationRequests, [
    {secret: true, pin: OLD_PIN},
    {pin: OLD_PIN},
  ]);
  assert.deepEqual(state.cardPINWrites, [{pin: OLD_PIN}]);
  assert.equal(state.businessCompleted, 1);
  assert.equal(state.savedPINs[CARD_ID], OLD_PIN);
  assert.equal(state.outcome, 'resolved');
});

test('prompt: an initialized card proceeds without requesting or rewriting its Secret PIN', async () => {
  const state = mount({
    allowSetup: true,
    savedPINs: {[CARD_ID]: PIN},
  });
  await state.tap();
  await state.finishExit();
  assert.deepEqual(state.inputs, []);
  assert.deepEqual(state.cardPINWrites, []);
  assert.deepEqual(state.authenticationRequests, [{pin: PIN}]);
  assert.equal(state.savedPINs[CARD_ID], PIN);
  assert.deepEqual(state.writes, []);
  assert.equal(state.businessCompleted, 1);
  assert.equal(state.outcome, 'resolved');
});

test('prompt: both PINs initialized between taps discard the pending setup PIN', async () => {
  const state = mount({
    allowSetup: true,
    accessPIN: false,
    secretPIN: false,
    savedPINs: {[CARD_ID]: PIN},
  });
  await state.tap();
  await state.finishExit();
  await state.enterPIN(SECRET_PIN);
  state.accessPIN = 5;
  state.secretPIN = 5;
  await state.tap();
  await state.finishExit();

  assert.equal(state.inputs.length, 1);
  assert.deepEqual(state.cardPINWrites, []);
  assert.deepEqual(state.authenticationRequests, [{pin: PIN}]);
  assert.deepEqual(state.writes, []);
  assert.equal(state.businessCompleted, 1);
  assert.equal(state.outcome, 'resolved');
});

test('prompt: a lost response after setting Secret PIN cannot replay the pending write', async () => {
  const state = mount({
    allowSetup: true,
    accessPIN: false,
    secretPIN: false,
    onSetCardPIN: () => {
      state.accessPIN = 5;
      state.secretPIN = 5;
      throw tagLost();
    },
  });
  await state.tap();
  await state.finishExit();
  await state.enterPIN(SECRET_PIN);
  await state.tap();
  await state.finishExit();

  assert.deepEqual(state.cardPINWrites, [{secret: true, pin: SECRET_PIN}]);
  assert.deepEqual(state.authenticationRequests, []);
  assert.deepEqual(state.writes, []);
  assert.equal(state.scans.length, 2);
  assert.equal(state.inputs.length, 1);
  assert.equal(state.businessCalls, 0);
  assert.equal(state.outcome, 'rejected');
  assert.equal(state.errors[0].code, 'CANCELLED');
});

for (const differentIdentity of ['Identity ID', 'Identity public key']) {
  test(`prompt: setup rejects a different ${differentIdentity} before sending a PIN`, async () => {
    const state = mount({allowSetup: true, accessPIN: false, secretPIN: false});
    await state.tap();
    await state.finishExit();
    await state.enterPIN(SECRET_PIN);
    if (differentIdentity === 'Identity ID') state.cardId = OTHER_CARD_ID;
    else state.identityPublicKey[64] = 1;
    const scan = await state.tap();

    assert.equal(scan.waitingForRemoval, true);
    assert.deepEqual(state.authenticationRequests, []);
    assert.deepEqual(state.cardPINWrites, []);
    assert.deepEqual(state.writes, []);
    assert.equal(state.businessCalls, 0);
    assert.equal(state.presentedErrors.length, 1);
    assert.ok(state.presentedErrors[0] instanceof MonoidWrongCardError);
    await state.finishExit();
    assert.equal(state.scans.length, 3);
    assert.equal(state.inputs.length, 1);
    assert.deepEqual(state.retryErrors, state.presentedErrors);
    assert.deepEqual(state.notifications, []);

    state.cardId = CARD_ID;
    state.identityPublicKey[64] = 0;
    await state.tap();
    await state.finishExit();
    assert.equal(state.businessCompleted, 1);
    assert.equal(state.savedPINs[CARD_ID], SECRET_PIN);
    assert.equal(state.outcome, 'resolved');
  });
}

test('prompt: incorrect Secret PIN reopens input after cleanup without mutating Access PIN', async () => {
  const state = mount({
    allowSetup: true,
    accessPIN: false,
    onAuthenticate: () => {
      throw wrongPIN();
    },
  });
  await state.tap();
  await state.finishExit();
  await state.enterPIN(OLD_PIN);
  const scan = await state.tap();
  assert.equal(scan.waitingForRemoval, false);
  assert.equal(state.inputs.length, 1);
  assert.deepEqual(state.cardPINWrites, []);
  await state.finishStop();
  assert.equal(state.inputs.length, 1);
  await state.finishAnimation();

  assert.equal(state.inputs.length, 2);
  assert.equal(
    state.inputs[1].options.placeholder,
    'Enter existing Secret PIN',
  );
  assert.match(state.notifications[0].message, /tries remaining: 4/);
  assert.deepEqual(state.removals, []);
  assert.deepEqual(state.writes, []);
  state.onAuthenticate = undefined;
  await state.enterPIN(SECRET_PIN);
  await state.tap();
  await state.finishExit();
  assert.equal(state.businessCompleted, 1);
  assert.equal(state.savedPINs[CARD_ID], SECRET_PIN);
  assert.equal(state.outcome, 'resolved');
});

test('prompt: Secret PIN exhaustion ends setup without another attempt', async () => {
  const state = mount({
    allowSetup: true,
    accessPIN: false,
    onAuthenticate: () => {
      throw new CBORAppletError({code: 'INVALID_PIN', tries: 0});
    },
  });
  await state.tap();
  await state.finishExit();
  await state.enterPIN(SECRET_PIN);
  await state.tap();
  await state.finishExit();

  assert.equal(state.scans.length, 2);
  assert.equal(state.inputs.length, 1);
  assert.equal(state.businessCalls, 0);
  assert.deepEqual(state.cardPINWrites, []);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.removals, []);
  assert.equal(state.outcome, 'rejected');
  assert.match(state.errors[0].message, /Secret PIN blocked/);
});

test('prompt: cancelling Secret PIN entry leaves card and saved credentials untouched', async () => {
  const state = mount({allowSetup: true, accessPIN: false, secretPIN: false});
  await state.tap();
  await state.finishExit();
  state.inputs[0].resolve(undefined);
  await state.flush();

  assert.equal(state.scans.length, 1);
  assert.deepEqual(state.cardPINWrites, []);
  assert.deepEqual(state.writes, []);
  assert.equal(state.businessCalls, 0);
  assert.equal(state.outcome, 'rejected');
  assert.equal(state.errors[0].code, 'CANCELLED');
});

test('prompt: unmount while Secret PIN input is open ignores a late submission', async () => {
  const state = mount({allowSetup: true, accessPIN: false, secretPIN: false});
  await state.tap();
  await state.finishExit();
  state.owner.unmount();
  await state.enterPIN(SECRET_PIN);

  assert.equal(state.scans.length, 1);
  assert.deepEqual(state.cardPINWrites, []);
  assert.deepEqual(state.writes, []);
  assert.equal(state.businessCalls, 0);
  assert.equal(state.outcome, 'rejected');
  assert.equal(state.errors[0].code, 'CANCELLED');
});

test('prompt: unmount during Secret PIN authentication prevents subsequent PIN writes', async () => {
  const authentication = deferred();
  const state = mount({
    allowSetup: true,
    accessPIN: false,
    onAuthenticate: () => authentication.promise,
  });
  await state.tap();
  await state.finishExit();
  await state.enterPIN(SECRET_PIN);
  const tapping = state.tap();
  await state.flush();
  assert.deepEqual(state.authenticationRequests, [
    {secret: true, pin: SECRET_PIN},
  ]);
  state.owner.unmount();
  authentication.resolve();
  await tapping;

  assert.deepEqual(state.cardPINWrites, []);
  assert.deepEqual(state.writes, []);
  assert.equal(state.businessCalls, 0);
  assert.equal(state.outcome, 'rejected');
  assert.equal(state.errors[0].code, 'CANCELLED');
});

test('prompt: callers can handle Safe setup themselves with ensureSetup disabled', async () => {
  const state = mount({
    auth: false,
    allowSetup: true,
    ensureSetup: false,
    accessPIN: false,
    secretPIN: false,
  });
  await state.tap();
  await state.finishExit();

  assert.equal(state.inputs.length, 0);
  assert.equal(state.businessCalls, 1);
  assert.equal(state.businessHello.pins.secret, false);
  assert.deepEqual(state.cardPINWrites, []);
  assert.deepEqual(state.navigations, []);
  assert.equal(state.outcome, 'resolved');
});

for (const allowSetup of [undefined, false, true]) {
  test(`prompt: Hello always returns Identity and both PIN states (allowSetup: ${allowSetup})`, async () => {
    const state = mount({allowSetup, savedPINs: {[CARD_ID]: PIN}});
    await state.tap();
    await state.finishExit();

    assert.deepEqual(state.helloRequests, [{}]);
    assert.deepEqual(state.businessHello.publicKey, state.identityPublicKey);
    assert.deepEqual(state.businessHello.pins, {access: 5, secret: 5});
    assert.equal(state.businessHello.bundle, false);
    assert.equal(state.outcome, 'resolved');
    assert.deepEqual(state.authenticated, [PIN]);
  });
}

for (const [missing, overrides] of [
  ['applet', {}],
  ['Access PIN', {accessPIN: false}],
  ['Secret PIN', {secretPIN: false}],
]) {
  test(`prompt: iOS reports an uninitialized card as failure (missing ${missing})`, async () => {
    platform = 'ios';
    const state = mount({savedPINs: {[CARD_ID]: PIN}, ...overrides});
    const scan =
      missing === 'applet' ? await state.missingApplet() : await state.tap();

    assert.deepEqual(scan.closeOptions, {
      errorMessage: 'Initialize card from Safe',
    });
    assert.equal(scan.waitingForRemoval, false);
    assert.equal(scan.stopRequested, true);
    assert.equal(state.outcome, undefined);
    assert.equal(state.businessCalls, 0);
    assert.equal(state.inputs.length, 0);
    assert.deepEqual(state.authenticated, []);
    assert.deepEqual(state.notifications, []);
    await state.finishAnimation();
    assert.equal(state.outcome, undefined);
    await state.finishStop();

    assert.equal(state.outcome, 'rejected');
    assert.equal(isCredentialRequestCancelled(state.errors[0]), true);
    assert.equal(
      state.notifications.at(-1).message,
      'Initialize card from Safe',
    );
    assert.equal(state.scans.length, 1);
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.navigations, []);
  });

  test(`prompt: ordinary operations stop on an uninitialized card (missing ${missing})`, async () => {
    const missingApplet = missing === 'applet';
    const state = mount({savedPINs: {[CARD_ID]: PIN}, ...overrides});
    const scan = missingApplet
      ? await state.missingApplet({cleanup: false})
      : await state.tap({cleanup: false});

    assert.equal(scan.waitingForRemoval, true);
    assert.equal(scan.stopRequested, false);
    assert.equal(state.presenter.current.error, true);
    assert.equal(state.presenter.current.closing, false);
    assert.equal(state.presenter.current.content, 'Initialize card from Safe');
    assert.deepEqual(state.notifications, []);
    scan.onCleanup();
    await state.flush();
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
    assert.deepEqual(state.notifications, []);
  });
}

test('prompt: ensureSetup false passes an uninitialized Identity to its owning operation', async () => {
  const state = mount({auth: false, ensureSetup: false, accessPIN: false});
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
    await state.flush();
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

test('prompt: standby starts after preloading and selects the PIN by stable Identity ID', async () => {
  const read = deferred();
  const state = mount({onGet: () => read.promise});
  await state.flush();
  assert.equal(state.gets, 1);
  assert.equal(state.scans.length, 0);
  read.resolve(Object.freeze({[CARD_ID]: PIN, [OTHER_CARD_ID]: OLD_PIN}));
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

test('prompt: auth false never reads or stores a Secret PIN used by the business action', async () => {
  const secretPIN = 'Secret PIN 1';
  const state = mount({
    auth: false,
    onBusiness: applet => applet.authenticate({pin: secretPIN}),
  });
  await state.tap();
  assert.equal(state.gets, 0);
  assert.deepEqual(state.readSignals, []);
  assert.deepEqual(state.authenticated, [secretPIN]);
  assert.equal(state.businessCompleted, 1);
  await state.finishExit();
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.removals, []);
  assert.equal(state.inputs.length, 0);
  assert.equal(state.outcome, 'resolved');
});

test('prompt: a temporary scope spans preloading, retries, final animation and saving', async () => {
  const state = mount();
  await state.enterManualPIN();
  assert.equal(state.unlocks, 1);
  assert.equal(state.disposals, 0);
  const saving = deferred();
  state.onSet = () => saving.promise;
  await state.tap();
  await state.finishAnimation();
  assert.equal(state.disposals, 0);
  await state.finishStop();
  assert.equal(state.writes.length, 1);
  assert.equal(state.disposals, 0);
  saving.resolve();
  await state.flush();
  assert.equal(state.unlocks, 1);
  assert.equal(state.disposals, 1);
  assert.equal(state.outcome, 'resolved');
});

test('prompt: temporary scope cleanup failure does not report completed card work as failed', async () => {
  const state = mount({savedPINs: {[CARD_ID]: PIN}});
  state.onDispose = () => {
    throw new Error('secret cleanup payload');
  };
  await state.tap();
  await state.finishExit();
  assert.equal(state.outcome, 'resolved');
  assert.equal(state.businessCalls, 1);
  assert.equal(state.disposals, 1);
  assert.deepEqual(state.errors, []);
  assert.equal(state.retryErrors.length, 1);
  assert.equal(state.retryErrors[0].code, 'IO_ERROR');
  assert.equal(state.retryErrors[0].message.includes('secret'), false);
});

test('prompt: auth false can first acquire the page authorization when saving after scan returns', async () => {
  const state = mount({auth: false, pinSession: true});
  await state.tap();
  await state.finishExit();
  assert.equal(state.outcome, 'resolved');
  assert.equal(state.unlocks, 0);
  await state.pinSession.setPIN(CARD_ID, PIN);
  assert.equal(state.unlocks, 1);
  assert.equal(state.disposals, 0);
  assert.equal(state.savedPINs[CARD_ID], PIN);
  await state.pinSession[Symbol.asyncDispose]();
  assert.equal(state.disposals, 1);
});

test('prompt: a completed scan cannot overwrite progress in the next scan', async () => {
  let lateProgress;
  const state = mount({
    auth: false,
    onBusiness: (_applet, setContent) => {
      lateProgress = setContent;
      setContent('Reading addresses');
    },
  });
  await state.tap();
  await state.finishExit();
  assert.equal(state.outcome, 'resolved');
  state.start();
  await state.flush();
  const current = state.presenter.current;
  const before = current.content;
  lateProgress('Stale progress');
  await state.flush();
  assert.equal(state.presenter.current.token, current.token);
  assert.equal(state.presenter.current.content, before);
});
