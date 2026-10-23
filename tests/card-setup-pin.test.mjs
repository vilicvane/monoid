import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {
  MonoidCardError,
  MonoidWrongCardError,
} from '../.bld/app/@lib/monoid/card-error.js';
import {initializeMonoidCard} from '../.bld/app/@lib/monoid/initialize-card.js';

let fixture;
const owners = [];
const PIN = 'setup-pin';

mock.module('react', {
  namedExports: {
    useRef: current => ({current}),
    useEffect: effect => {
      fixture.cleanup = effect();
    },
  },
});
mock.module('react/jsx-runtime', {
  namedExports: {
    jsx: (type, props) => ({type, props}),
    jsxs: (type, props) => ({type, props}),
    Fragment: 'fragment',
  },
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => fixture.entrances},
});
mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {
    MonoidCardError,
    MonoidWrongCardError,
    initializeMonoidCard,
  },
});
mock.module('../.bld/app/@services/index.js', {
  namedExports: {
    isCredentialRequestCancelled: error =>
      error?.code === 'CANCELLED' || error?.code === 'APP_INACTIVE',
  },
});
mock.module('../.bld/app/@components/@ui/toast.js', {
  namedExports: {useToast: () => fixture.toast},
});
mock.module('../.bld/app/@components/@ui/use-input-modal.js', {
  namedExports: {useInputModal: () => ['pin-input', fixture.prompt]},
});
mock.module('../.bld/app/@components/@monoid/pin-input-placeholder.js', {
  namedExports: {
    PINKind: ({kind}) => kind,
    getPINInputPlaceholder: (kind, prefix) => ({
      placeholder: `${prefix} ${kind} PIN`,
    }),
  },
});
mock.module('../.bld/app/@components/@monoid/monoid-scan-prompt.js', {
  namedExports: {
    MonoidScanStatePromptContentHighlight: 'highlight',
    useMonoidScanPrompt: options => {
      fixture.scanOptions = options;
      return ['scan-input', fixture.scan];
    },
  },
});

const {CardSetupPIN} = await import(
  '../.bld/app/@components/views/safe/@card/card-setup-pin.js'
);

const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node.type === 'function') return textOf(node.type(node.props));
  return textOf(node.props?.children);
}

function assertConfirmedHello(state) {
  assert.deepEqual(state.latestHellos, [
    {
      ...state.current,
      pins: {access: 5, secret: 5},
    },
  ]);
}

function mount({
  accessPIN = false,
  secretPIN = false,
  hello: initialHello,
  pinSession,
  onInitialized,
} = {}) {
  const state = {
    inputs: [],
    scans: [],
    commands: [],
    saved: [],
    toasts: [],
    errors: [],
    results: [],
    latestHellos: [],
    finished: deferred(),
    hello: initialHello ?? {
      version: 0,
      id: bytes('11223344'),
      publicKey: bytes(`04${'12'.repeat(64)}`),
      bundle: false,
      pins: {access: accessPIN, secret: secretPIN},
    },
  };
  state.current = structuredClone(state.hello);
  state.applet = {
    authenticate: async request => {
      state.commands.push(['authenticate', request]);
      await state.onAuthenticate?.(request);
    },
    setPIN: async request => {
      state.commands.push(['setPIN', request]);
      await state.onWrite?.(request);
    },
    hello: async request => {
      state.commands.push(['hello', request]);
      if (state.onHello) return state.onHello();
      return {
        ...state.current,
        pins: {
          access:
            state.current.pins.access === false ? 5 : state.current.pins.access,
          secret: 5,
        },
      };
    },
  };
  state.store = {
    setPIN: async (id, pin, signal) => {
      state.saved.push({id, pin, signal});
      await state.onSave?.(signal);
    },
  };
  state.prompt = options => {
    const input = {...deferred(), options};
    state.inputs.push(input);
    return input.promise;
  };
  state.scan = (label, callback, validate) => {
    const scan = {
      ...deferred(),
      label,
      callback,
      validate,
      controller: new AbortController(),
      contents: [],
    };
    state.scans.push(scan);
    return scan.promise;
  };
  state.toast = options => state.toasts.push(options);
  state.entrances = {
    monoidCredentialsStore: state.store,
    errorService: {
      catch: promise => promise.catch(error => state.errors.push(error)),
    },
  };
  state.answer = async value => {
    state.inputs.at(-1).resolve(value);
    await setImmediate();
  };
  state.tap = async (hello = state.current) => {
    const scan = state.scans.at(-1);
    state.current = hello;
    try {
      scan.validate(hello);
      await scan.callback(
        state.applet,
        content => scan.contents.push(content),
        hello,
        scan.controller.signal,
      );
    } catch (error) {
      scan.reject(error);
      throw error;
    }
  };
  state.finishScan = async () => {
    const scan = state.scans.at(-1);
    scan.resolve();
    // The ordinary scan hook disposes its credential signal after success.
    scan.controller.abort();
    await state.finished.promise;
    await setImmediate();
  };
  state.cancelScan = () => {
    const reason = Object.assign(new Error('Cancelled'), {code: 'CANCELLED'});
    const scan = state.scans.at(-1);
    scan.controller.abort(reason);
    scan.reject(reason);
  };
  state.unmount = () => {
    state.cleanup?.();
    state.cleanup = undefined;
  };

  fixture = state;
  state.tree = CardSetupPIN({
    hello: state.hello,
    pinSession,
    onInitialized,
    onFinished: (initialized, latestHello) => {
      state.results.push(initialized);
      state.latestHellos.push(latestHello);
      state.finished.resolve();
    },
  });
  owners.push(state);
  return state;
}

afterEach(() => owners.splice(0).forEach(state => state.unmount()));

test('a new card opens the Secret PIN prompt immediately and stores the verified default Access PIN only after scan exit', async () => {
  const state = mount();
  assert.equal(state.inputs.length, 1);
  assert.deepEqual(state.scans, []);
  const {options} = state.inputs[0];
  assert.equal(options.placeholder, 'Set Secret PIN');
  assert.equal(options.type, 'password');
  assert.equal(options.maxLength, 16);
  assert.equal(options.defaultValue, undefined);
  assert.equal(
    textOf(options.description),
    'Will be used as initial Access PIN',
  );
  assert.equal(textOf(state.tree), 'pin-inputscan-input');

  await state.answer(PIN);
  assert.deepEqual(state.scanOptions, {
    ensureSetup: false,
    auth: false,
    retryOnError: false,
    pinSession: undefined,
  });
  assert.equal(textOf(state.scans[0].label), 'Scan card 11223344');
  await state.tap();
  assert.deepEqual(state.commands, [
    ['setPIN', {secret: true, pin: PIN}],
    ['hello', {}],
    ['authenticate', {pin: PIN}],
  ]);
  assert.deepEqual(state.results, []);
  assert.deepEqual(state.saved, []);

  await state.finishScan();
  assert.deepEqual(state.results, [true]);
  assertConfirmedHello(state);
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].id, '11223344');
  assert.equal(state.saved[0].pin, PIN);
  assert.notEqual(state.saved[0].signal, state.scans[0].controller.signal);
  assert.equal(state.saved[0].signal.aborted, false);
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.toasts, []);
});

test('a provided page PIN session owns the scan and saves the verified Access PIN after scan exit', async () => {
  const saves = [];
  const pinSession = {
    async setPIN(id, pin, signal) {
      saves.push({id, pin, signal});
    },
    clear() {
      assert.fail('The page retains ownership of its PIN session');
    },
  };
  const state = mount({pinSession});
  assert.equal(state.scanOptions.pinSession, pinSession);
  await state.answer(PIN);
  await state.tap();
  assert.deepEqual(saves, []);
  await state.finishScan();

  assert.deepEqual(state.results, [true]);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].id, '11223344');
  assert.equal(saves[0].pin, PIN);
  assert.equal(saves[0].signal.aborted, false);
  assert.notEqual(saves[0].signal, state.scans[0].controller.signal);
  assert.deepEqual(state.saved, []);
  assert.deepEqual(state.toasts, []);
  state.unmount();
});

test('an expired page PIN session warns without falling back to another authentication', async () => {
  const pinSession = {
    async setPIN() {
      throw {code: 'AUTHORIZATION_EXPIRED'};
    },
  };
  const state = mount({pinSession});
  await state.answer(PIN);
  await state.tap();
  await state.finishScan();

  assert.deepEqual(state.results, [true]);
  assert.deepEqual(state.saved, []);
  assert.deepEqual(state.toasts, [
    {message: 'Access PIN was not saved on this device', color: 'warning'},
  ]);
});

test('an already initialized card returns its confirmed hello without prompting or scanning', async () => {
  const state = mount({accessPIN: 5, secretPIN: 5});
  await state.finished.promise;

  assert.deepEqual(state.results, [true]);
  assertConfirmedHello(state);
  assert.equal(state.latestHellos[0], state.hello);
  assert.deepEqual(state.inputs, []);
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.commands, []);
  assert.deepEqual(state.saved, []);
});

test('invalid PIN formats stay in the input flow without scanning', async () => {
  const state = mount();
  for (const invalid of ['short', '汉字不是ASCII', 'x'.repeat(17)]) {
    await state.answer(invalid);
    assert.equal(
      state.inputs.at(-1).options.description,
      'Use 6 to 16 ASCII characters',
    );
    assert.equal(state.inputs.at(-1).options.defaultValue, undefined);
    assert.deepEqual(state.scans, []);
  }
  await state.answer(undefined);
  await state.finished.promise;
  assert.deepEqual(state.results, [false]);
  assert.deepEqual(state.commands, []);
  assert.deepEqual(state.saved, []);
});

for (const field of ['applet ID', 'Safe public key']) {
  test(`a different ${field} is rejected before sending credentials`, async () => {
    const state = mount();
    await state.answer(PIN);
    const wrong = structuredClone(state.current);
    if (field === 'applet ID') wrong.id = bytes('55667788');
    else wrong.publicKey = bytes(`04${'34'.repeat(64)}`);

    await assert.rejects(state.tap(wrong), MonoidWrongCardError);
    await state.finished.promise;
    assert.deepEqual(state.results, [false]);
    assert.deepEqual(state.latestHellos, [undefined]);
    assert.deepEqual(state.commands, []);
    assert.deepEqual(state.saved, []);
  });
}

for (const blocked of ['accessPIN', 'secretPIN']) {
  test(`a blocked ${blocked} reports the error without opening a setup prompt`, async () => {
    const state = mount({[blocked]: 0});
    await state.finished.promise;
    assert.deepEqual(state.inputs, []);
    assert.deepEqual(state.scans, []);
    assert.deepEqual(state.commands, []);
    assert.deepEqual(state.results, [false]);
    assert.equal(state.errors.length, 1);
    assert.match(state.errors[0].message, /PIN blocked/);
  });
}

test('an existing Secret PIN initializes only the missing Access PIN', async () => {
  const state = mount({accessPIN: false, secretPIN: 5});
  assert.equal(
    state.inputs[0].options.placeholder,
    'Enter existing Secret PIN',
  );
  assert.equal(
    textOf(state.inputs[0].options.description),
    'Will be used as initial Access PIN',
  );
  await state.answer(PIN);
  await state.tap();
  await state.finishScan();

  assert.equal(state.scans[0].contents[0], 'Setting Access PIN, hold tight...');
  assert.deepEqual(state.results, [true]);
  assertConfirmedHello(state);
  assert.deepEqual(state.commands, [
    ['authenticate', {secret: true, pin: PIN}],
    ['setPIN', {pin: PIN}],
    ['hello', {}],
    ['authenticate', {pin: PIN}],
  ]);
  assert.equal(state.saved.length, 1);
});

test('a card initialized before the second scan succeeds without overwriting or saving the entered PIN', async () => {
  const state = mount();
  await state.answer(PIN);
  const initialized = {
    ...state.current,
    pins: {access: 5, secret: 5},
  };
  await state.tap(initialized);
  await state.finishScan();

  assert.deepEqual(state.results, [true]);
  assertConfirmedHello(state);
  assert.equal(state.latestHellos[0], initialized);
  assert.deepEqual(state.commands, []);
  assert.deepEqual(state.saved, []);
});

test('a newly set Secret PIN returns its fresh state so retry initializes only the missing Access PIN', async () => {
  const state = mount();
  await state.answer(PIN);
  const changed = {
    ...state.current,
    pins: {access: false, secret: 5},
  };

  await assert.rejects(state.tap(changed), {
    message: 'Secret PIN already set, enter existing PIN',
  });
  await state.finished.promise;
  assert.deepEqual(state.results, [false]);
  assert.deepEqual(state.commands, []);
  assert.deepEqual(state.saved, []);
  assert.equal(state.latestHellos[0], changed);

  const retry = mount({hello: state.latestHellos[0]});
  assert.equal(
    retry.inputs[0].options.placeholder,
    'Enter existing Secret PIN',
  );
  await retry.answer('existing-pin');
  await retry.tap();
  await retry.finishScan();

  assert.deepEqual(retry.results, [true]);
  assertConfirmedHello(retry);
  assert.deepEqual(retry.commands, [
    ['authenticate', {secret: true, pin: 'existing-pin'}],
    ['setPIN', {pin: 'existing-pin'}],
    ['hello', {}],
    ['authenticate', {pin: 'existing-pin'}],
  ]);
  assert.equal(retry.saved.length, 1);
  assert.equal(retry.latestHellos[0].pins.access, 5);
});

test('cancelling before the second scan leaves setup available without writing or saving', async () => {
  const state = mount();
  await state.answer(PIN);
  state.cancelScan();
  await state.finished.promise;

  assert.deepEqual(state.results, [false]);
  assert.deepEqual(state.commands, []);
  assert.deepEqual(state.saved, []);
  assert.deepEqual(state.errors, []);
});

for (const stage of ['input', 'scan']) {
  test(`unmounting during ${stage} prevents late work and completion callbacks`, async () => {
    const state = mount();
    if (stage === 'scan') await state.answer(PIN);
    state.unmount();
    if (stage === 'input') await state.answer(PIN);
    else await assert.rejects(state.tap(), {name: 'AbortError'});
    await setImmediate();

    assert.deepEqual(state.results, []);
    assert.deepEqual(state.commands, []);
    assert.deepEqual(state.saved, []);
    assert.deepEqual(state.errors, []);
  });
}

test('cancelling during a write waits for its response and does not claim unverified initialization', async () => {
  const state = mount();
  const write = deferred();
  state.onWrite = () => write.promise;
  await state.answer(PIN);
  const tapping = state.tap();
  const rejected = assert.rejects(tapping, error => error.code === 'CANCELLED');
  await setImmediate();
  state.cancelScan();
  await setImmediate();
  assert.deepEqual(state.results, []);

  write.resolve();
  await rejected;
  await state.finished.promise;
  assert.deepEqual(state.results, [false]);
  assert.deepEqual(state.commands, [['setPIN', {secret: true, pin: PIN}]]);
  assert.deepEqual(state.saved, []);
  assert.deepEqual(state.errors, []);
});

test('cancelling after verified initialization preserves success without starting credential storage', async () => {
  const state = mount();
  const authentication = deferred();
  state.onAuthenticate = () => authentication.promise;
  await state.answer(PIN);
  const tapping = state.tap();
  const rejected = assert.rejects(tapping, error => error.code === 'CANCELLED');
  await setImmediate();
  assert.equal(state.commands.at(-1)[0], 'authenticate');
  state.cancelScan();
  await setImmediate();
  assert.deepEqual(state.results, []);

  authentication.resolve();
  await rejected;
  await state.finished.promise;
  assert.deepEqual(state.results, [true]);
  assertConfirmedHello(state);
  assert.deepEqual(state.saved, []);
  assert.deepEqual(state.toasts, [
    {message: 'Access PIN was not saved on this device', color: 'warning'},
  ]);
  assert.deepEqual(state.errors, []);
});

test('unmounting during an outstanding write aborts its continuation without a late finish callback', async () => {
  const state = mount();
  const write = deferred();
  state.onWrite = () => write.promise;
  await state.answer(PIN);
  const tapping = state.tap();
  const rejected = assert.rejects(tapping, error => error.code === 'CANCELLED');
  await setImmediate();
  state.unmount();
  write.resolve();
  await rejected;
  await setImmediate();

  assert.deepEqual(state.results, []);
  assert.deepEqual(state.commands, [['setPIN', {secret: true, pin: PIN}]]);
  assert.deepEqual(state.saved, []);
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.toasts, []);
});

test('a local credential save failure warns without reversing the confirmed card setup', async () => {
  const state = mount();
  state.onSave = async () => {
    throw new Error('Storage unavailable');
  };
  await state.answer(PIN);
  await state.tap();
  await state.finishScan();

  assert.deepEqual(state.results, [true]);
  assertConfirmedHello(state);
  assert.equal(state.saved.length, 1);
  assert.deepEqual(state.toasts, [
    {message: 'Access PIN was not saved on this device', color: 'warning'},
  ]);
  assert.deepEqual(state.errors, []);
});

test('unmounting during credential storage aborts its separate signal and suppresses late UI', async () => {
  const state = mount();
  const saving = deferred();
  state.onSave = () => saving.promise;
  await state.answer(PIN);
  await state.tap();
  state.scans[0].resolve();
  await setImmediate();
  assert.equal(state.saved.length, 1);
  state.unmount();
  assert.equal(state.saved[0].signal.aborted, true);
  saving.reject(Object.assign(new Error('Cancelled'), {code: 'CANCELLED'}));
  await setImmediate();

  assert.deepEqual(state.results, []);
  assert.deepEqual(state.toasts, []);
  assert.deepEqual(state.errors, []);
});

test('confirmed setup is retained by its owner after navigation during authentication', async () => {
  const acknowledged = [];
  const state = mount({onInitialized: hello => acknowledged.push(hello)});
  const authentication = deferred();
  state.onAuthenticate = () => authentication.promise;
  await state.answer(PIN);
  const tapping = state.tap();
  const rejected = assert.rejects(tapping, {name: 'AbortError'});
  await setImmediate();
  assert.equal(state.commands.at(-1)[0], 'authenticate');
  assert.deepEqual(acknowledged, []);

  state.unmount();
  authentication.resolve();
  await rejected;
  await setImmediate();

  assert.equal(acknowledged.length, 1);
  assert.deepEqual(acknowledged[0].pins, {access: 5, secret: 5});
  assert.deepEqual(state.results, []);
  assert.deepEqual(state.saved, []);
});

test('an unverified write never acknowledges setup to its owner', async () => {
  const acknowledged = [];
  const state = mount({onInitialized: hello => acknowledged.push(hello)});
  const write = deferred();
  state.onWrite = () => write.promise;
  await state.answer(PIN);
  const tapping = state.tap();
  const rejected = assert.rejects(tapping, error => error.code === 'CANCELLED');
  await setImmediate();
  state.unmount();
  write.resolve();
  await rejected;
  await setImmediate();

  assert.deepEqual(acknowledged, []);
  assert.deepEqual(state.results, []);
});
