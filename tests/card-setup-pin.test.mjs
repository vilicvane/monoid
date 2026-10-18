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

function mount({
  accessPIN = false,
  safePIN = false,
  unlocked = false,
  hello: initialHello,
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
      pin: accessPIN,
      features: {curves: []},
      safe: {
        id: bytes('aabbccdd'),
        publicKey: bytes(`04${'12'.repeat(64)}`),
        pin: safePIN,
        unlocked,
      },
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
        pin: state.current.pin === false ? 5 : state.current.pin,
        safe: {...state.current.safe, pin: 5, unlocked: true},
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

test('a new card opens the Safe PIN prompt immediately and stores the verified default Access PIN only after scan exit', async () => {
  const state = mount();
  assert.equal(state.inputs.length, 1);
  assert.deepEqual(state.scans, []);
  const {options} = state.inputs[0];
  assert.equal(options.placeholder, 'Set Safe PIN');
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
    safe: true,
    ensureSetup: false,
    auth: false,
    retryOnError: false,
  });
  assert.equal(textOf(state.scans[0].label), 'Scan card aabbccdd');
  await state.tap();
  assert.deepEqual(state.commands, [
    ['setPIN', {safe: true, pin: PIN}],
    ['hello', {safe: true}],
    ['authenticate', {pin: PIN}],
  ]);
  assert.deepEqual(state.results, []);
  assert.deepEqual(state.saved, []);

  await state.finishScan();
  assert.deepEqual(state.results, [true]);
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].id, '11223344');
  assert.equal(state.saved[0].pin, PIN);
  assert.notEqual(state.saved[0].signal, state.scans[0].controller.signal);
  assert.equal(state.saved[0].signal.aborted, false);
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.toasts, []);
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
    else wrong.safe.publicKey = bytes(`04${'34'.repeat(64)}`);

    await assert.rejects(state.tap(wrong), MonoidWrongCardError);
    await state.finished.promise;
    assert.deepEqual(state.results, [false]);
    assert.deepEqual(state.latestHellos, [undefined]);
    assert.deepEqual(state.commands, []);
    assert.deepEqual(state.saved, []);
  });
}

for (const accessPIN of [false, 5]) {
  test(`an existing Safe PIN is requested to restore setup while ${accessPIN === false ? 'creating' : 'preserving'} the Access PIN`, async () => {
    const state = mount({accessPIN, safePIN: 5});
    assert.equal(
      state.inputs[0].options.placeholder,
      'Enter existing Safe PIN',
    );
    assert.equal(
      textOf(state.inputs[0].options.description),
      accessPIN === false
        ? 'Will be used as initial Access PIN'
        : 'Access PIN stays the same',
    );
    await state.answer(PIN);
    await state.tap();
    await state.finishScan();

    assert.deepEqual(state.results, [true]);
    assert.deepEqual(state.commands, [
      ['authenticate', {safe: true, pin: PIN}],
      ['setPIN', {safe: true, pin: PIN}],
      ['hello', {safe: true}],
      ...(accessPIN === false ? [['authenticate', {pin: PIN}]] : []),
    ]);
    assert.equal(state.saved.length, accessPIN === false ? 1 : 0);
  });
}

test('a card initialized before the second scan succeeds without overwriting or saving the entered PIN', async () => {
  const state = mount();
  await state.answer(PIN);
  const initialized = {
    ...state.current,
    pin: 5,
    safe: {...state.current.safe, pin: 5, unlocked: true},
  };
  await state.tap(initialized);
  await state.finishScan();

  assert.deepEqual(state.results, [true]);
  assert.deepEqual(state.commands, []);
  assert.deepEqual(state.saved, []);
});

test('a newly set but locked Safe returns its fresh state so retry requests the existing PIN', async () => {
  const state = mount();
  await state.answer(PIN);
  const changed = {
    ...state.current,
    pin: 5,
    safe: {...state.current.safe, pin: 5},
  };

  await assert.rejects(state.tap(changed), {
    message: 'Safe PIN already set, enter existing PIN',
  });
  await state.finished.promise;
  assert.deepEqual(state.results, [false]);
  assert.deepEqual(state.commands, []);
  assert.deepEqual(state.saved, []);
  assert.equal(state.latestHellos[0], changed);

  const retry = mount({hello: state.latestHellos[0]});
  assert.equal(retry.inputs[0].options.placeholder, 'Enter existing Safe PIN');
  await retry.answer('existing-pin');
  await retry.tap();
  await retry.finishScan();

  assert.deepEqual(retry.results, [true]);
  assert.deepEqual(retry.commands, [
    ['authenticate', {safe: true, pin: 'existing-pin'}],
    ['setPIN', {safe: true, pin: 'existing-pin'}],
    ['hello', {safe: true}],
  ]);
  assert.deepEqual(retry.saved, []);
  assert.equal(retry.latestHellos[0].safe.unlocked, true);
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
  assert.deepEqual(state.commands, [['setPIN', {safe: true, pin: PIN}]]);
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
  assert.deepEqual(state.commands, [['setPIN', {safe: true, pin: PIN}]]);
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
