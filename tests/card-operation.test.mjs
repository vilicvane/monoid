import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {observable, runInAction} from 'mobx';

let rendering;
const owners = [];

mock.module('react', {
  namedExports: {
    useState(initial) {
      const owner = rendering;
      const slot = owner.slot(() => ({value: initial}));
      return [
        slot.value,
        value => {
          assert(owner.mounted, 'No state writes after unmount');
          slot.value = value;
        },
      ];
    },
    useRef: initial => rendering.slot(() => ({current: initial})),
    useEffect(effect, dependencies) {
      const slot = rendering.slot(() => ({}));
      if (
        !slot.dependencies ||
        dependencies.some((value, index) => value !== slot.dependencies[index])
      ) {
        slot.cleanup?.();
        slot.dependencies = dependencies;
        slot.cleanup = effect();
      }
    },
  },
});
mock.module('@capacitor/app', {
  namedExports: {
    App: {
      addListener: async (_event, callback) => {
        const owner = rendering;
        owner.background = callback;
        return {
          remove: () => {
            owner.background = undefined;
          },
        };
      },
    },
  },
});
mock.module('../.bld/app/@components/@monoid/monoid-scan-prompt.js', {
  namedExports: {
    MonoidScanRedirectError: class extends Error {
      code = 'CANCELLED';
    },
  },
});
const {useCardOperation} = await import(
  '../.bld/app/@components/@monoid/use-card-operation.js'
);

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return {promise, resolve, reject};
}

function mount({background = false} = {}) {
  const owner = {
    slots: [],
    mounted: true,
    route: observable({active: true}),
    events: [],
    scans: [],
    pins: {'00000001': 'Access-42'},
    slot: create => (owner.slots[owner.index++] ??= create()),
    render() {
      owner.index = 0;
      rendering = owner;
      owner.runner = useCardOperation(owner.options);
      rendering = undefined;
      return owner.runner;
    },
    leave() {
      runInAction(() => {
        owner.route.active = false;
      });
    },
    unmount() {
      owner.mounted = false;
      owner.slots.splice(0).forEach(slot => slot.cleanup?.());
    },
  };
  owner.options = {
    active: () => owner.route.active,
    pinSession: {
      clear: mock.fn(),
      getPINs: mock.fn(async signal => {
        owner.events.push('unlock');
        owner.unlockSignal = signal;
        await owner.unlock?.promise;
        return owner.pins;
      }),
    },
    scan: async (content, callback, validate, signal, authentication) => {
      owner.events.push('scan');
      const finished = deferred();
      owner.scans.push({
        content,
        callback,
        validate,
        signal,
        authentication,
        finished,
      });
      await finished.promise;
    },
    onLeave: mock.fn(),
    onBackground: background ? mock.fn() : undefined,
  };
  const visibility = new Map();
  globalThis.document = {
    hidden: false,
    addEventListener: (event, handler) => visibility.set(event, handler),
    removeEventListener: event => visibility.delete(event),
  };
  owner.hide = () => {
    globalThis.document.hidden = true;
    visibility.get('visibilitychange')?.();
  };
  owner.visibility = visibility;
  owners.push(owner);
  owner.render();
  return owner;
}

afterEach(() => owners.splice(0).forEach(owner => owner.unmount()));

test('one operation owns the slot before render and through awaited cleanup', async () => {
  const state = mount();
  const cleanup = deferred();
  const task = state.runner.run(async ({scan}) => {
    try {
      await scan('first', async () => {});
    } finally {
      await cleanup.promise;
    }
  });
  const duplicate = mock.fn();
  await state.runner.run(duplicate);
  assert.equal(duplicate.mock.callCount(), 0);
  assert.equal(state.render().busy, true);
  await setImmediate();
  assert.deepEqual(state.events, ['unlock', 'scan']);
  state.runner.abort();
  state.scans[0].finished.resolve();
  await setImmediate();
  await state.runner.run(duplicate);
  assert.equal(duplicate.mock.callCount(), 0);
  assert.equal(state.runner.running(), true);
  cleanup.resolve();
  await task;
  assert.equal(state.render().busy, false);
  await state.runner.run(duplicate);
  assert.equal(duplicate.mock.callCount(), 1);
  state.leave();
  await state.runner.run(duplicate);
  state.unmount();
  await state.runner.run(duplicate);
  assert.equal(duplicate.mock.callCount(), 1);
});

test('PIN preload is shared across manual input and subsequent scans, with authentication and signals preserved', async () => {
  const state = mount();
  const tapped = new AbortController();
  const supplied = new AbortController();
  const aid = Uint8Array.of(1, 2, 3);
  const hello = {};
  const validate = mock.fn();
  let callbackSignal;
  const task = state.runner.run(async ({getPINs, scan}) => {
    state.events.push('warmup');
    assert.equal(await getPINs(), state.pins);
    state.events.push('input');
    await scan(
      'first',
      async (_applet, _state, _hello, signal) => {
        callbackSignal = signal;
        state.events.push('write');
        return {message: ''};
      },
      validate,
      supplied.signal,
      {
        aid,
        prepare: async (_applet, _state, _hello, signal) => {
          assert.notEqual(signal, tapped.signal);
          state.events.push('prepare');
        },
      },
    );
    await scan('next', async () => {});
  });
  await setImmediate();
  const first = state.scans[0];
  assert.equal(first.content, 'first');
  assert.equal(first.authentication.aid, aid);
  first.validate(hello);
  assert.equal(validate.mock.calls[0].arguments[0], hello);
  await first.authentication.prepare({}, () => {}, hello, tapped.signal);
  assert.deepEqual(await first.callback({}, () => {}, hello, tapped.signal), {
    message: '',
  });
  tapped.abort();
  assert.equal(callbackSignal.aborted, true);
  assert.equal(first.signal.aborted, false);
  first.finished.resolve();
  await setImmediate();
  assert.equal(state.scans.length, 2);
  state.scans[1].finished.resolve();
  await task;
  assert.deepEqual(state.events, [
    'warmup',
    'unlock',
    'input',
    'scan',
    'prepare',
    'write',
    'scan',
  ]);
  assert.equal(state.options.pinSession.getPINs.mock.callCount(), 1);
  assert.equal(state.options.pinSession.clear.mock.callCount(), 0);
});

test('failed preload releases PIN authorization and a new explicit operation can unlock again', async () => {
  const state = mount();
  state.unlock = deferred();
  const failure = new Error('Vault failed');
  const task = state.runner.run(async ({scan}) => {
    await scan('scan', async () => {});
  });
  const rejected = assert.rejects(task, error => error === failure);
  state.unlock.reject(failure);
  await rejected;
  assert.equal(state.scans.length, 0);
  assert.equal(state.options.pinSession.clear.mock.callCount(), 1);
  assert.equal(state.render().busy, false);
  state.unlock = undefined;
  await state.runner.run(async ({getPINs}) => {
    await getPINs();
  });
  assert.equal(state.options.pinSession.getPINs.mock.callCount(), 2);
});

test('leaving or unmounting during unlock prevents late NFC and clears the session', async () => {
  for (const action of ['leave', 'unmount']) {
    const state = mount();
    state.unlock = deferred();
    const task = state.runner.run(async ({scan}) => {
      await scan('scan', async () => {});
    });
    state[action]();
    assert.equal(state.unlockSignal.aborted, true);
    state.unlock.resolve();
    await task;
    assert.equal(state.scans.length, 0);
    assert(state.options.pinSession.clear.mock.callCount() > 0);
    if (state.mounted) assert.equal(state.render().busy, false);
  }
});

test('background and visibility preserve biometric unlock, then abort NFC without restarting on foreground', async () => {
  for (const event of ['background', 'visibility']) {
    const state = mount({background: true});
    state.unlock = deferred();
    const background = () =>
      event === 'background'
        ? state.background({isActive: false})
        : state.hide();
    const task = state.runner.run(async ({scan}) => {
      await scan('scan', async () => {});
    });
    background();
    assert.equal(state.unlockSignal.aborted, false);
    assert.equal(state.options.pinSession.clear.mock.callCount(), 0);
    state.unlock.resolve();
    await setImmediate();
    assert.equal(state.scans.length, 1);
    background();
    assert.equal(state.scans[0].signal.aborted, true);
    state.scans[0].finished.resolve();
    await task;
    globalThis.document.hidden = false;
    state.background({isActive: true});
    await setImmediate();
    assert.equal(state.scans.length, 1);
    background();
    assert.equal(state.options.pinSession.clear.mock.callCount(), 1);
    assert.equal(state.options.onBackground.mock.callCount(), 3);
    state.unmount();
    await setImmediate();
    assert.equal(state.background, undefined);
    assert.equal(state.visibility.size, 0);
  }
});

test('quiet cancellation and real errors both release the slot without replaying a scan', async () => {
  for (const error of [
    new DOMException('aborted', 'AbortError'),
    {code: 'CANCELLED'},
    {code: 'APP_INACTIVE'},
    new Error('Unknown write result'),
  ]) {
    const state = mount();
    const task = state.runner.run(async ({scan}) => {
      await scan('write', async () => {});
    });
    const completed =
      error.message === 'Unknown write result'
        ? assert.rejects(task, actual => actual === error)
        : task;
    await setImmediate();
    state.scans[0].finished.reject(error);
    await completed;
    assert.equal(state.render().busy, false);
    assert.equal(state.scans.length, 1);
  }
});

test('late validators, preparation and callbacks are blocked after the view leaves', async () => {
  const state = mount();
  const callback = mock.fn(async () => {});
  const validate = mock.fn();
  const task = state.runner.run(async ({scan}) => {
    await scan('scan', callback, validate, undefined, {prepare: callback});
  });
  await setImmediate();
  const scan = state.scans[0];
  state.leave();
  assert.throws(() => scan.validate({}), {name: 'AbortError'});
  assert.throws(
    () => scan.callback({}, () => {}, {}, new AbortController().signal),
    {name: 'AbortError'},
  );
  assert.throws(
    () =>
      scan.authentication.prepare(
        {},
        () => {},
        {},
        new AbortController().signal,
      ),
    {name: 'AbortError'},
  );
  assert.equal(callback.mock.callCount(), 0);
  assert.equal(validate.mock.callCount(), 0);
  scan.finished.resolve();
  await task;
});

test('rerenders retain the operation and use the latest leave handler', async () => {
  const state = mount();
  const task = state.runner.run(async ({scan}) => {
    await scan('scan', async () => {});
  });
  await setImmediate();
  const original = state.options.onLeave;
  state.options.onLeave = mock.fn();
  state.render();
  assert.equal(state.scans[0].signal.aborted, false);
  state.leave();
  assert.equal(original.mock.callCount(), 0);
  assert.equal(state.options.onLeave.mock.callCount(), 1);
  state.scans[0].finished.resolve();
  await task;
});
