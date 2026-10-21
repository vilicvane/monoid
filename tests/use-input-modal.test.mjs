import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';

let rendering;
const owners = [];

mock.module('react', {
  namedExports: {
    useId: () => 'input-description',
    useRef: initial => {
      const index = rendering.refIndex++;
      return (rendering.refs[index] ??= {current: initial});
    },
    useState: initial => {
      const state = rendering;
      const index = state.stateIndex++;
      if (!(index in state.values)) state.values[index] = initial;
      state.setters[index] ??= value => {
        state.stateWrites++;
        state.values[index] =
          typeof value === 'function' ? value(state.values[index]) : value;
      };
      return [state.values[index], state.setters[index]];
    },
    useCallback: (callback, dependencies) => {
      const index = rendering.callbackIndex++;
      const previous = rendering.callbacks[index];
      if (
        !previous ||
        dependencies.some(
          (dependency, position) =>
            !Object.is(dependency, previous.dependencies[position]),
        )
      ) {
        rendering.callbacks[index] = {callback, dependencies};
      }
      return rendering.callbacks[index].callback;
    },
    useEffect: (effect, dependencies) => {
      const index = rendering.effectIndex++;
      const previous = rendering.effects[index];
      if (
        !previous ||
        dependencies.some(
          (dependency, position) =>
            !Object.is(dependency, previous.dependencies[position]),
        )
      ) {
        rendering.pendingEffects.push({index, effect, dependencies});
      }
    },
  },
});
mock.module('react/jsx-runtime', {
  namedExports: {
    Fragment: 'fragment',
    jsx: (type, props, key) => ({type, props, key}),
    jsxs: (type, props, key) => ({type, props, key}),
  },
});
mock.module('react-dom', {
  namedExports: {createPortal: children => children},
});
mock.module('styled-components', {
  namedExports: {
    styled: {div: () => 'div', input: () => 'input'},
  },
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => ({portals: {popup: 'popup'}})},
});
mock.module('../.bld/app/@components/@animations.js', {
  namedExports: {fadeInAnimationCSS: '', fadeOutAnimationCSS: ''},
});
mock.module('../.bld/app/@components/@ui/popup-backdrop.js', {
  namedExports: {PopupBackdrop: 'backdrop'},
});
mock.module('../.bld/app/@components/@ui/popup-layout.js', {
  namedExports: {popupContentPaddingCSS: ''},
});

const {useInputModal} = await import(
  '../.bld/app/@components/@ui/use-input-modal.js'
);

function find(node, predicate) {
  if (!node) return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const result = find(child, predicate);
      if (result) return result;
    }
    return undefined;
  }
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}

function mount() {
  const state = {
    refs: [],
    values: [],
    setters: [],
    callbacks: [],
    effects: [],
    pendingEffects: [],
    stateWrites: 0,
    render() {
      rendering = state;
      state.refIndex = 0;
      state.stateIndex = 0;
      state.callbackIndex = 0;
      state.effectIndex = 0;
      [state.content, state.show] = useInputModal();
      for (const {index, effect, dependencies} of state.pendingEffects) {
        state.effects[index]?.cleanup?.();
        state.effects[index] = {dependencies, cleanup: effect()};
      }
      state.pendingEffects = [];
      return state.content;
    },
    input() {
      return find(state.content, node => node.type === 'input');
    },
    container() {
      return find(state.content, node => node.props?.onAnimationEnd);
    },
    type(value) {
      state.input().props.onChange({target: {value}});
      state.render();
    },
    enter() {
      state.input().props.onKeyDown({key: 'Enter'});
      state.render();
    },
    finishAnimation() {
      const target = {};
      state.container().props.onAnimationEnd({target, currentTarget: target});
      state.render();
    },
    unmount() {
      for (const effect of state.effects) effect.cleanup?.();
      state.effects = [];
    },
  };
  state.render();
  owners.push(state);
  return state;
}

function trackedController() {
  const controller = new AbortController();
  const listeners = new Set();
  const {signal} = controller;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, options) => {
    if (type === 'abort') listeners.add(listener);
    add(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === 'abort') listeners.delete(listener);
    remove(type, listener, options);
  };
  return {controller, signal, listeners};
}

afterEach(() => {
  for (const state of owners.splice(0)) state.unmount();
});

test('an already aborted request resolves without opening or replacing input', async () => {
  const state = mount();
  const current = state.show({placeholder: 'Current PIN'});
  state.render();
  const key = state.container().key;
  const {controller, signal, listeners} = trackedController();
  controller.abort();

  assert.equal(await state.show({placeholder: 'Cancelled'}, signal), undefined);
  state.render();
  assert.equal(state.input().props.placeholder, 'Current PIN');
  assert.equal(state.container().key, key);
  assert.equal(listeners.size, 0);
  state.unmount();
  assert.equal(await current, undefined);
});

test('abort clears the active input and resolves without waiting for an animation', async () => {
  const state = mount();
  const {controller, signal, listeners} = trackedController();
  const result = state.show({type: 'password'}, signal);
  state.render();
  state.type('not-to-be-returned');
  assert.equal(listeners.size, 1);

  controller.abort();
  state.render();
  assert.equal(await result, undefined);
  assert.equal(state.content, undefined);
  assert.equal(listeners.size, 0);

  const next = state.show({});
  state.render();
  assert.equal(state.input().props.value, '');
  state.unmount();
  assert.equal(await next, undefined);
});

test('normal completion waits for the closing animation and releases its signal', async () => {
  const state = mount();
  const {controller, signal, listeners} = trackedController();
  let resolved = false;
  const result = state.show({}, signal).then(value => {
    resolved = true;
    return value;
  });
  state.render();
  state.type('test-pin');
  state.enter();
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(listeners.size, 1);
  assert.equal(state.input().props.readOnly, true);

  state.finishAnimation();
  assert.equal(await result, 'test-pin');
  assert.equal(listeners.size, 0);
  assert.equal(state.content, undefined);
  const next = state.show({placeholder: 'Next PIN'});
  state.render();
  controller.abort();
  state.render();
  assert.equal(state.input().props.placeholder, 'Next PIN');
  state.unmount();
  await next;
});

test('abort during exit discards the submitted value and stale events cannot close a new instance', async () => {
  const state = mount();
  const {controller, signal, listeners} = trackedController();
  const result = state.show({}, signal);
  state.render();
  state.type('discarded');
  state.enter();
  const oldContainer = state.container();
  const oldInput = state.input();
  controller.abort();
  state.render();
  assert.equal(await result, undefined);
  assert.equal(listeners.size, 0);

  const next = state.show({placeholder: 'New input'});
  state.render();
  const key = state.container().key;
  assert.notEqual(key, oldContainer.key);
  oldInput.props.onBlur();
  const target = {};
  oldContainer.props.onAnimationEnd({target, currentTarget: target});
  state.render();
  assert.equal(state.container().key, key);
  assert.equal(state.input().props.readOnly, false);
  state.unmount();
  await next;
});

test('replacing an input settles it and an old abort cannot cancel its replacement', async () => {
  const state = mount();
  const first = trackedController();
  const second = trackedController();
  const oldResult = state.show({placeholder: 'Old'}, first.signal);
  state.render();
  const result = state.show({placeholder: 'New'}, second.signal);
  state.render();
  assert.equal(await oldResult, undefined);
  assert.equal(first.listeners.size, 0);
  first.controller.abort();
  state.render();
  assert.equal(state.input().props.placeholder, 'New');
  assert.equal(second.listeners.size, 1);
  second.controller.abort();
  state.render();
  assert.equal(await result, undefined);
  assert.equal(second.listeners.size, 0);
  assert.equal(state.content, undefined);
});

test('unmount resolves pending input and releases the signal without state writes', async () => {
  const state = mount();
  const {controller, signal, listeners} = trackedController();
  const result = state.show({}, signal);
  state.render();
  state.type('unsaved');
  const writes = state.stateWrites;
  state.unmount();
  assert.equal(await result, undefined);
  assert.equal(listeners.size, 0);
  assert.equal(state.stateWrites, writes);
  controller.abort();
  assert.equal(state.stateWrites, writes);
});
