import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {observable, runInAction} from 'mobx';

import {MonoidWrongCardError} from '../.bld/app/@lib/monoid/card-error.js';
import {MonoidPINSession} from '../.bld/app/@services/monoid-credentials-store.js';

let fixture;
const owners = [];
mock.module('react', {
  namedExports: {
    useMemo: create => create(),
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
mock.module('mobx-react-lite', {
  namedExports: {observer: component => component},
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => fixture.entrances},
});
mock.module('../.bld/app/@components/@ui/toast.js', {
  namedExports: {useToast: () => fixture.toast},
});
mock.module('../.bld/app/@components/@ui/use-input-modal.js', {
  namedExports: {useInputModal: () => [null, fixture.prompt]},
});
mock.module('../.bld/app/@components/@monoid/pin-input-placeholder.js', {
  namedExports: {
    getPINInputPlaceholder: (kind, prefix) => ({
      placeholder: `${prefix} ${kind} PIN`,
    }),
  },
});
mock.module('../.bld/app/@components/@monoid/monoid-scan-prompt.js', {
  namedExports: {
    useMonoidScanPrompt: options => {
      fixture.scanOptions = options;
      return [null, fixture.scan];
    },
  },
});
const {useViewActive} = await import(
  '../.bld/app/@components/@view/use-view-active.js'
);
mock.module('../.bld/app/@components/@view/index.js', {
  namedExports: {useViewActive},
});
const {CardPINUpdate} = await import(
  '../.bld/app/@components/views/safe/@card/card-pin-update.js'
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
function mount(kind = 'Access') {
  const state = {
    kind,
    inputs: [],
    scans: [],
    auth: [],
    writes: [],
    saved: [],
    toasts: [],
    errors: [],
    done: false,
    finished: deferred(),
    card: {
      id: 'aabbccdd',
      publicKey: `04${'12'.repeat(64)}`,
      bundle: false,
      items: [],
    },
    view: observable({$leaving: false, $match: {$exact: {$active: true}}}),
  };
  state.hello = {
    version: 0,
    id: bytes(state.card.id),
    publicKey: bytes(state.card.publicKey),
    bundle: false,
    pins: {access: 5, secret: 5},
  };
  state.applet = {
    authenticate: async request => {
      state.auth.push(request);
    },
    setPIN: async request => {
      state.writes.push(request);
    },
  };
  state.store = {
    getPINs: async () => ({[state.card.id]: 'old-access'}),
    setPIN: async (id, pin) => {
      state.saved.push({id, pin});
      return {[id]: pin};
    },
  };
  state.pinSession = new MonoidPINSession(state.store);
  state.prompt = options => {
    const request = {...deferred(), options};
    state.inputs.push(request);
    return request.promise;
  };
  state.scan = (label, callback, validate) => {
    const request = {
      ...deferred(),
      label,
      callback,
      validate,
      controller: new AbortController(),
    };
    state.scans.push(request);
    return request.promise;
  };
  state.toast = options => state.toasts.push(options);
  state.entrances = {
    errorService: {
      catch: promise => promise.catch(error => state.errors.push(error)),
    },
  };
  state.answer = async value => {
    state.inputs.at(-1).resolve(value);
    await setImmediate();
  };
  state.prepare = async () => {
    await state.answer('old-safe');
    await state.answer('new-pin');
    await state.answer('new-pin');
  };
  state.tap = async (hello = state.hello) => {
    const scan = state.scans.at(-1);
    scan.validate(hello);
    await scan.callback(state.applet, () => {}, hello, scan.controller.signal);
  };
  state.finishScan = async () => {
    state.scans.at(-1).resolve();
    await state.finished.promise;
  };
  state.view.$match.$view = () => ({$entries: [state.view]});
  fixture = state;
  CardPINUpdate({
    ...state,
    onFinished: () => {
      state.done = true;
      state.finished.resolve();
    },
  });
  owners.push(state);
  return state;
}
afterEach(() => owners.splice(0).forEach(state => state.cleanup?.()));

for (const kind of ['Access', 'Secret']) {
  test(`${kind} PIN flow confirms input, validates the card and stores only Access PIN under the Identity ID`, async () => {
    const state = mount(kind);
    await state.prepare();
    assert.deepEqual(
      state.inputs.map(input => input.options.placeholder),
      [
        'Enter current Secret PIN',
        `Enter new ${kind} PIN`,
        `Confirm new ${kind} PIN`,
      ],
    );
    assert.ok(
      state.inputs.every(
        input =>
          input.options.type === 'password' &&
          input.options.defaultValue === undefined,
      ),
    );
    assert.equal(state.scanOptions.auth, false);
    assert.equal(state.scanOptions.ensureSetup, false);
    assert.equal(state.scanOptions.retryOnError, false);
    assert.deepEqual(state.saved, []);
    await assert.rejects(
      state.tap({
        ...state.hello,
        publicKey: bytes(`04${'34'.repeat(64)}`),
      }),
      MonoidWrongCardError,
    );
    assert.deepEqual(state.auth, []);
    await state.tap();
    assert.deepEqual(state.saved, []);
    await state.finishScan();
    assert.deepEqual(state.auth, [{secret: true, pin: 'old-safe'}]);
    assert.deepEqual(state.writes, [
      {pin: 'new-pin', ...(kind === 'Secret' && {secret: true})},
    ]);
    assert.deepEqual(
      state.saved,
      kind === 'Access' ? [{id: state.card.id, pin: 'new-pin'}] : [],
    );
    assert.deepEqual(state.toasts, [{message: `${kind} PIN updated`}]);
  });
}

test('invalid input and mismatching confirmation stay in the input flow without scanning', async () => {
  const state = mount();
  await state.answer('short');
  assert.equal(
    state.inputs.at(-1).options.description,
    'Use 6 to 16 ASCII characters',
  );
  await state.answer('old-safe');
  await state.answer('new-pin');
  await state.answer('different-pin');
  assert.equal(state.inputs.at(-1).options.description, 'PINs do not match');
  assert.deepEqual(state.scans, []);
  await state.answer(undefined);
  await state.finished.promise;
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.saved, []);
});

for (const stage of ['input', 'scan']) {
  test(`leaving during ${stage} ends the flow without waiting for another tap or input`, async () => {
    const state = mount();
    if (stage === 'scan') await state.prepare();
    runInAction(() => {
      state.view.$leaving = true;
    });
    await state.finished.promise;
    assert.deepEqual(state.auth, []);
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.saved, []);
    assert.deepEqual(state.toasts, []);
  });
}

test('a failed local save reports the committed card update once and keeps the replacement in the page cache', async () => {
  const state = mount();
  await state.pinSession.getPINs();
  state.store.setPIN = async () => {
    throw new Error('save cancelled');
  };
  await state.prepare();
  await state.tap();
  await state.finishScan();
  assert.deepEqual(await state.pinSession.getPINs(), {
    [state.card.id]: 'new-pin',
  });
  assert.deepEqual(state.toasts, [
    {
      message: 'Access PIN updated, but not saved on this device',
      color: 'warning',
    },
  ]);
  assert.deepEqual(state.errors, []);
});

test('dismissing during setPIN waits for the ACK, retains the new cached PIN, and does not start a vault prompt', async () => {
  const state = mount();
  await state.pinSession.getPINs();
  await state.prepare();
  const release = deferred();
  state.applet.setPIN = async request => {
    state.writes.push(request);
    await release.promise;
  };
  const tapping = state.tap();
  await setImmediate();
  const scan = state.scans[0];
  scan.controller.abort();
  scan.reject(Object.assign(new Error('Cancelled'), {code: 'CANCELLED'}));
  await setImmediate();
  assert.equal(state.done, false);
  assert.equal(state.writes.length, 1);
  release.resolve();
  await tapping;
  await state.finished.promise;
  assert.deepEqual(await state.pinSession.getPINs(), {
    [state.card.id]: 'new-pin',
  });
  assert.deepEqual(state.saved, []);
  assert.equal(state.toasts.length, 1);
  assert.equal(state.toasts[0].color, 'warning');
});
