import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

import {reaction} from 'mobx';
import {routra} from 'routra';

let rendering;
mock.module('react', {
  namedExports: {
    useMemo(create, dependencies) {
      const previous = rendering.memo;
      if (
        !previous ||
        dependencies.some(
          (value, index) => value !== previous.dependencies[index],
        )
      ) {
        rendering.memo = {dependencies, value: create()};
      }
      return rendering.memo.value;
    },
  },
});

const {useViewActive} = await import(
  '../.bld/app/@components/@view/use-view-active.js'
);

function mount(view, options) {
  const owner = {
    render() {
      rendering = owner;
      try {
        return useViewActive(view, options);
      } finally {
        rendering = undefined;
      }
    },
  };
  owner.isActive = owner.render();
  return owner;
}

async function openCard() {
  const router = routra({safe: {card: true, copy: true}}, {});
  await router.safe.$reset().$completed;
  await router.safe.card.$push().$completed;
  const source = router.safe.card.$view();
  const [view] = source.$entries;
  const activity = mount(view);
  return {router, source, view, activity};
}

test('a real Routra view can finish leaving before reaction cleanup without reading its expired proxy', async context => {
  const {router, source, view, activity} = await openCard();
  const changes = [];
  const errors = [];
  const stop = reaction(activity.isActive, active => changes.push(active), {
    fireImmediately: true,
    onError: error => errors.push(error),
  });
  context.after(stop);
  view.$transition({leaving: true});

  const closing = router.$backTo(router.safe.$exact)();
  assert.equal(activity.isActive(), false);
  assert.deepEqual(changes, [true, false]);
  view.$leaving.$complete();
  await closing.$completed;

  assert.deepEqual(source.$entries, []);
  assert.throws(() => view.$leaving, /entry/);
  assert.equal(activity.isActive(), false);
  assert.equal(activity.render(), activity.isActive);
  assert.deepEqual(errors, []);

  await router.safe.copy.$push().$completed;
  assert.equal(activity.isActive(), false);
  assert.deepEqual(changes, [true, false]);
  assert.deepEqual(errors, []);
});

test('an aborted swipe stays active and a committed swipe invalidates the old view before cleanup', async context => {
  const {router, view, activity} = await openCard();
  const changes = [];
  const errors = [];
  const stop = reaction(activity.isActive, active => changes.push(active), {
    fireImmediately: true,
    onError: error => errors.push(error),
  });
  context.after(stop);

  const cancelled = router.$back.$switch({progress: 0.3});
  assert.equal(activity.isActive(), true);
  cancelled.$abort();
  assert.equal(activity.isActive(), true);
  assert.deepEqual(changes, [true]);

  const completed = router.$back.$switch({progress: 1});
  completed.$complete();
  assert.equal(activity.isActive(), false);
  assert.throws(() => view.$leaving, /entry/);
  assert.deepEqual(changes, [true, false]);
  assert.deepEqual(errors, []);
});

test('same-route replacements reuse their view but a removed view never reactivates on reentry', async context => {
  const {router, source, view, activity} = await openCard();
  const errors = [];
  const stop = reaction(activity.isActive, () => {}, {
    onError: error => errors.push(error),
  });
  context.after(stop);

  await router.safe.card.$replace().$completed;
  assert.equal(source.$entries[0], view);
  assert.equal(activity.isActive(), true);
  await router.safe.card.$reset().$completed;
  assert.equal(source.$entries[0], view);
  assert.equal(activity.isActive(), true);

  await router.safe.$reset().$completed;
  assert.equal(activity.isActive(), false);
  await router.safe.card.$push().$completed;
  const [replacement] = source.$entries;
  assert.notEqual(replacement, view);
  assert.equal(router.safe.card.$active, true);
  assert.equal(activity.isActive(), false);
  assert.equal(mount(replacement).isActive(), true);
  assert.deepEqual(errors, []);
});

test('entry-time scan failure can remain actionable without reviving a departed view', async () => {
  const router = routra({safe: {scan: true}}, {});
  await router.safe.$reset().$completed;
  const opening = router.safe.scan.$push();
  const [view] = router.safe.scan.$view().$entries;
  view.$transition({entering: true, leaving: true});
  const active = mount(view);
  const present = mount(view, {allowEntering: true});

  assert.equal(active.isActive(), false);
  assert.equal(present.isActive(), true);
  view.$entering.$complete();
  await opening.$completed;
  assert.equal(active.isActive(), true);
  assert.equal(present.isActive(), true);

  const closing = router.safe.$replace();
  assert.equal(present.isActive(), false);
  view.$leaving.$complete();
  await closing.$completed;
  assert.equal(present.isActive(), false);
});
