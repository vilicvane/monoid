import assert from 'node:assert/strict';
import {after, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

let rendering;

mock.module('react', {
  namedExports: {
    useRef(initial) {
      const state = rendering;
      const index = state.refIndex++;
      return (state.refs[index] ??= {
        current: initial === null ? state.elements.shift() : initial,
      });
    },
    useLayoutEffect(effect, dependencies) {
      const state = rendering;
      const index = state.effectIndex++;
      const previous = state.effects[index];
      if (
        !previous ||
        dependencies.some(
          (value, position) =>
            !Object.is(value, previous.dependencies[position]),
        )
      ) {
        state.pendingEffects.push({index, effect, dependencies});
      }
    },
  },
});
mock.module('react/jsx-runtime', {
  namedExports: {
    Fragment: 'fragment',
    jsx: (type, props) => ({type, props}),
    jsxs: (type, props) => ({type, props}),
  },
});
mock.module('styled-components', {
  namedExports: {
    styled: Object.assign(type => () => type, {div: () => 'div'}),
  },
});
mock.module('../.bld/app/@components/@ui/loading-spinner.js', {
  namedExports: {StandaloneLoadingSpinner: 'spinner'},
});

const {QrScanPreview} = await import(
  '../.bld/app/@components/@ui/qr-scan-preview.js'
);
const originalGlobals = Object.fromEntries(
  ['window', 'getComputedStyle'].map(name => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]),
);
after(() => {
  for (const [name, descriptor] of Object.entries(originalGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return {promise, resolve, reject};
}

function fixture(t, props = {}, reduced = false) {
  const motions = [];
  const element = (name, style) => ({
    name,
    style,
    getAnimations() {
      return motions.filter(
        motion => motion.element === this && !motion.cancelled,
      );
    },
    animate(keyframes, options) {
      const completion = deferred();
      const motion = {
        element: this,
        keyframes,
        options,
        cancelled: false,
        finished: completion.promise,
        effect: {getTiming: () => options},
        finish() {
          if (!this.cancelled) completion.resolve();
        },
        cancel() {
          this.cancelled = true;
          if (options.iterations !== Infinity) {
            completion.reject(new Error('Animation cancelled'));
          }
        },
      };
      motions.push(motion);
      return motion;
    },
  });
  const aperture = element('aperture', {
    inset: '50%',
    borderRadius: '50%',
    backgroundColor: '#f0f0f0',
    opacity: '1',
  });
  const cover = element('cover', {
    inset: '0px',
    borderRadius: '0px',
    backgroundColor: 'white',
    opacity: '0',
  });
  const media = {
    matches: reduced,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = {matchMedia: () => media};
  globalThis.getComputedStyle = element => ({...element.style});
  const state = {
    refs: [],
    effects: [],
    elements: [aperture, cover, null],
    motions,
    aperture,
    cover,
    reveals: [],
    settled: [],
    covered: 0,
    props: {
      phase: 'starting',
      showProcessingSpinner: false,
      onReveal: async duration => {
        state.reveals.push(duration);
        return true;
      },
      onCovered: () => state.covered++,
      onSettled: phase => state.settled.push(phase),
      ...props,
    },
    render(next = {}) {
      Object.assign(state.props, next);
      state.refIndex = 0;
      state.effectIndex = 0;
      state.pendingEffects = [];
      rendering = state;
      state.tree = QrScanPreview(state.props);
      for (const {index, effect, dependencies} of state.pendingEffects) {
        state.effects[index]?.cleanup?.();
        state.effects[index] = {dependencies, cleanup: effect()};
      }
    },
    finishAnimations() {
      for (const motion of motions) {
        if (!motion.cancelled && motion.options.iterations !== Infinity) {
          motion.finish();
        }
      }
    },
    cleanup() {
      for (const {cleanup} of state.effects.splice(0)) cleanup?.();
    },
  };
  state.render();
  t.after(() => state.cleanup());
  return state;
}

test('resuming immediately shows a full static frame under an opaque cover', async t => {
  const state = fixture(t, {revealMode: 'fade'});
  assert.equal(state.aperture.style.inset, '0%');
  assert.equal(state.aperture.style.borderRadius, '20px');
  assert.equal(state.cover.style.opacity, '1');
  assert.equal(state.cover.style.backgroundColor, '#f0f0f0');
  assert.deepEqual(state.motions, []);
  await setImmediate();
  assert.deepEqual(state.motions, []);
  assert.deepEqual(state.reveals, []);
});

test('resuming waits for native readiness, then fades only the cover before settling', async t => {
  const ready = deferred();
  const reveals = [];
  const state = fixture(t, {
    revealMode: 'fade',
    onReveal: duration => {
      reveals.push(duration);
      return ready.promise;
    },
  });
  state.render({phase: 'scanning'});
  assert.deepEqual(reveals, [0]);
  assert.equal(state.cover.style.opacity, '1');
  assert.deepEqual(state.motions, []);

  ready.resolve(true);
  await setImmediate();
  assert.equal(state.motions.length, 1);
  const fade = state.motions[0];
  assert.equal(fade.element, state.cover);
  assert.deepEqual(fade.keyframes, [{opacity: '1'}, {opacity: '0'}]);
  assert.equal(fade.options.duration, 160);
  assert.ok(!state.settled.includes('scanning'));
  fade.finish();
  await setImmediate();
  assert.equal(state.cover.style.opacity, '0');
  assert.equal(state.aperture.style.inset, '0%');
  assert.equal(state.settled.at(-1), 'scanning');
});

for (const action of ['pause', 'unmount']) {
  test(`${action} while awaiting native reveal prevents a stale cover fade`, async t => {
    const ready = deferred();
    const state = fixture(t, {
      phase: 'scanning',
      revealMode: 'fade',
      onReveal: () => ready.promise,
    });
    if (action === 'pause') state.render({phase: 'idle'});
    else state.cleanup();
    const count = state.motions.length;
    ready.resolve(true);
    await setImmediate();
    assert.equal(state.motions.length, count);
    assert.ok(!state.settled.includes('scanning'));
  });
}

test('another resume cancels an unfinished fade and restores the opaque full frame', async t => {
  const state = fixture(t, {phase: 'scanning', revealMode: 'fade'});
  await setImmediate();
  const oldFade = state.motions[0];
  state.cover.style.opacity = '0.4';
  state.render({phase: 'starting'});
  assert.equal(oldFade.cancelled, true);
  assert.equal(state.cover.style.opacity, '1');
  assert.equal(state.aperture.style.inset, '0%');
  oldFade.finish();
  await setImmediate();
  assert.equal(state.cover.style.opacity, '1');
  assert.equal(state.motions.length, 1);
  assert.ok(!state.settled.includes('scanning'));
});

test('initial entry keeps its breathing circle and aperture zoom', async t => {
  const state = fixture(t);
  assert.ok(
    state.motions.some(motion => motion.keyframes.at(-1).inset === '40%'),
  );
  state.finishAnimations();
  await setImmediate();
  const breathing = state.motions.find(
    motion => motion.options.iterations === Infinity,
  );
  assert.equal(breathing.element, state.aperture);
  assert.ok(breathing.keyframes.some(frame => frame.inset === '38%'));

  state.render({phase: 'scanning'});
  await setImmediate();
  assert.equal(breathing.cancelled, true);
  assert.deepEqual(state.reveals, [480]);
  const zoom = state.motions.at(-1);
  assert.equal(zoom.element, state.aperture);
  assert.equal(zoom.keyframes.at(-1).inset, '0%');
  assert.equal(zoom.options.duration, 480);
  zoom.finish();
  await setImmediate();
  assert.equal(state.settled.at(-1), 'scanning');
});

test('reduced motion keeps the full frame and reveals without a timed fade', async t => {
  const state = fixture(t, {phase: 'scanning', revealMode: 'fade'}, true);
  await setImmediate();
  assert.deepEqual(state.reveals, [0]);
  assert.equal(state.motions.length, 1);
  assert.equal(state.motions[0].element, state.cover);
  assert.equal(state.motions[0].options.duration, 0);
  state.finishAnimations();
  await setImmediate();
  assert.equal(state.cover.style.opacity, '0');
});

test('a rejected native reveal leaves the resumed camera covered', async t => {
  const state = fixture(t, {
    phase: 'scanning',
    revealMode: 'fade',
    onReveal: async () => false,
  });
  await setImmediate();
  assert.equal(state.cover.style.opacity, '1');
  assert.deepEqual(state.motions, []);
  assert.ok(!state.settled.includes('scanning'));
});
