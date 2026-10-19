import assert from 'node:assert/strict';
import {after, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

let rendering;
let platform;
let sendMessage;
let entrances;

mock.module('@capacitor/core', {
  namedExports: {Capacitor: {getPlatform: () => platform}},
});
mock.module('capacitor-isodep-nfc', {
  namedExports: {
    IsoDepNfc: {setSessionMessage: options => sendMessage(options)},
  },
});
mock.module('mobx-react-lite', {
  namedExports: {observer: component => component},
});
mock.module('react', {
  namedExports: {
    useRef(initial) {
      const index = rendering.refIndex++;
      return (rendering.refs[index] ??= {current: initial});
    },
    useState(initial) {
      const state = rendering;
      const index = state.stateIndex++;
      if (!(index in state.values)) {
        state.values[index] =
          typeof initial === 'function' ? initial() : initial;
      }
      return [state.values[index], value => (state.values[index] = value)];
    },
    useLayoutEffect(effect, dependencies) {
      const index = rendering.effectIndex++;
      const previous = rendering.effects[index];
      if (
        !previous ||
        dependencies.some(
          (dependency, position) =>
            !Object.is(dependency, previous.dependencies[position]),
        )
      ) {
        rendering.pending.push({index, effect, dependencies});
      }
    },
  },
});
mock.module('react/jsx-runtime', {
  namedExports: {
    jsx: (type, props) => ({type, props}),
    jsxs: (type, props) => ({type, props}),
  },
});
mock.module('react-dom', {
  namedExports: {createPortal: children => children},
});
mock.module('styled-components', {
  namedExports: {styled: {div: () => 'div'}},
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => entrances},
});
mock.module('../.bld/app/@components/@ui/scan-sound.js', {
  namedExports: {playScanSound: () => () => {}},
});
mock.module('../.bld/app/@components/@monoid/monoid-scan-card.js', {
  namedExports: {MonoidScanCard: 'card'},
});

const {MonoidScanPromptHost} = await import(
  '../.bld/app/@components/@monoid/monoid-scan-prompt-host.js'
);
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
after(() => {
  if (originalWindow)
    Object.defineProperty(globalThis, 'window', originalWindow);
  else delete globalThis.window;
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

function element() {
  return {
    style: {},
    clientHeight: 800,
    getBoundingClientRect: () => ({top: 100, height: 200}),
    querySelector: () => ({style: {}}),
  };
}

function mount(t, options = {}) {
  platform = options.platform ?? 'ios';
  globalThis.window = {
    matchMedia: () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }),
  };
  const messages = [];
  const errors = [];
  sendMessage =
    options.sendMessage ?? (async message => messages.push(message));
  const state = {
    refs: [],
    values: [],
    effects: [],
    presentation: {
      owner: Symbol(),
      token: Symbol(),
      scanning: true,
      sessionId: 'session-a',
      content: 'Reading card',
      closing: false,
      onDismiss() {},
      ...options.presentation,
    },
    render(changes = {}, text = 'Reading card') {
      state.presentation = {...state.presentation, ...changes};
      entrances.monoidScanPromptPresenter.current = state.presentation;
      state.refIndex = 0;
      state.stateIndex = 0;
      state.effectIndex = 0;
      state.pending = [];
      rendering = state;
      const layer = MonoidScanPromptHost();
      const tree = layer.type(layer.props);
      rendering = undefined;

      // Commit refs and rendered DOM text before running layout effects. The
      // supplied text represents function components and line breaks in the DOM.
      const commit = node => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach(commit);
          return;
        }
        if (!node.props) return;
        const {ref, children} = node.props;
        if (ref) {
          ref.current ??= element();
          if (children === state.presentation.content)
            ref.current.innerText = text;
        }
        commit(children);
      };
      commit(tree);
      for (const {index, effect, dependencies} of state.pending) {
        state.effects[index]?.cleanup?.();
        state.effects[index] = {dependencies, cleanup: effect()};
      }
    },
    unmount() {
      for (const effect of state.effects.splice(0)) effect.cleanup?.();
    },
  };
  entrances = {
    monoidScanPromptPresenter: {current: state.presentation, remove() {}},
    errorService: {
      catch: promise => promise.catch(error => errors.push(error)),
    },
    portals: {
      popup: {},
      popupBackdrop: {async acquire() {}, async release() {}},
    },
  };
  state.render({}, options.text ?? 'Reading card');
  t.after(async () => {
    state.unmount();
    await setImmediate();
  });
  return {state, messages, errors};
}

test('iOS sends committed rendered progress text with line breaks and counts', async t => {
  const progress = {type: () => null, props: {current: 2, total: 5}};
  const {state, messages, errors} = mount(t, {
    presentation: {content: progress},
    text: '  Reading addresses, hold tight...\n2/5  ',
  });
  assert.deepEqual(messages, [
    {sessionId: 'session-a', message: 'Reading addresses, hold tight...\n2/5'},
  ]);
  state.render(
    {content: {...progress, props: {current: 3, total: 5}}},
    'Reading addresses, hold tight...\n3/5',
  );
  assert.deepEqual(messages.at(-1), {
    sessionId: 'session-a',
    message: 'Reading addresses, hold tight...\n3/5',
  });
  await setImmediate();
  assert.deepEqual(errors, []);
});

test('identical rendered text is deduplicated per session and sent again for a new session', t => {
  const {state, messages} = mount(t);
  state.render({content: {type: () => null, props: {}}});
  assert.equal(messages.length, 1);
  state.render({sessionId: 'session-b'});
  assert.deepEqual(messages, [
    {sessionId: 'session-a', message: 'Reading card'},
    {sessionId: 'session-b', message: 'Reading card'},
  ]);
});

for (const [name, presentation] of [
  ['disconnected', {sessionId: undefined}],
  ['not scanning', {scanning: false}],
  ['closing', {closing: true}],
  ['error', {error: true}],
]) {
  test(`${name} presentation does not overwrite native connection feedback`, t => {
    const {state, messages} = mount(t);
    state.render({...presentation, content: 'Late progress'}, 'Late progress');
    assert.equal(messages.length, 1);
  });
}

for (const platform of ['android', 'web']) {
  test(`${platform} presentation never invokes the iOS sheet message API`, t => {
    const {state, messages} = mount(t, {platform});
    state.render({content: 'Next phase'}, 'Next phase');
    assert.deepEqual(messages, []);
  });
}

test('empty rendered content does not erase the native hold-card message', t => {
  const {messages} = mount(t, {text: '  \n  '});
  assert.deepEqual(messages, []);
});

test('a stale native rejection after replacement cannot update the new session', async t => {
  const old = deferred();
  const sent = [];
  const {state, errors} = mount(t, {
    sendMessage: options => {
      sent.push(options);
      return options.sessionId === 'session-a'
        ? old.promise
        : Promise.resolve();
    },
  });
  state.render({sessionId: 'session-b', content: 'Second card'}, 'Second card');
  old.reject(
    Object.assign(new Error('Connection ended'), {code: 'SESSION_CLOSED'}),
  );
  await setImmediate();
  assert.deepEqual(errors, []);
  assert.deepEqual(sent, [
    {sessionId: 'session-a', message: 'Reading card'},
    {sessionId: 'session-b', message: 'Second card'},
  ]);
});

test('unexpected message failures are reported without dismissing or stopping the operation', async t => {
  const failure = Object.assign(new Error('Message unavailable'), {
    code: 'IO_ERROR',
  });
  let dismissed = false;
  const {state, errors} = mount(t, {
    presentation: {onDismiss: () => (dismissed = true)},
    sendMessage: async () => {
      throw failure;
    },
  });
  await setImmediate();
  assert.deepEqual(errors, [failure]);
  assert.equal(state.presentation.scanning, true);
  assert.equal(state.presentation.closing, false);
  assert.equal(dismissed, false);
});
