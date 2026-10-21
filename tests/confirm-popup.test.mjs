import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

let rendering;

mock.module('react', {
  namedExports: {
    useState(initial) {
      const owner = rendering;
      const index = owner.index++;
      const slot = (owner.slots[index] ??= {
        value: typeof initial === 'function' ? initial() : initial,
      });
      return [
        slot.value,
        update => {
          if (!owner.mounted) return;
          if (typeof update === 'function') {
            // React may replay state updaters; event side effects must remain outside them.
            update(slot.value);
            slot.value = update(slot.value);
          } else {
            slot.value = update;
          }
        },
      ];
    },
  },
});
mock.module('react/jsx-runtime', {
  namedExports: {
    jsx: (type, props) => ({type, props}),
    jsxs: (type, props) => ({type, props}),
  },
});
mock.module('styled-components', {
  namedExports: {styled: component => () => component},
});
mock.module('../.bld/app/@components/@ui/button.js', {
  namedExports: {Button: 'button', Buttons: 'buttons'},
});
mock.module('../.bld/app/@components/@ui/details-popup.js', {
  namedExports: {
    DetailsPopup: 'details-popup',
    DetailsPopupTitle: 'details-title',
  },
});
mock.module('../.bld/app/@components/@ui/info-section.js', {
  namedExports: {InfoSectionItemContent: 'description'},
});

const {ConfirmPopup} = await import(
  '../.bld/app/@components/@ui/confirm-popup.js'
);

function find(node, predicate) {
  if (node === null || node === undefined) return;
  if (predicate(node)) return node;
  const children = Array.isArray(node) ? node : [node.props?.children];
  for (const child of children) {
    const result = find(child, predicate);
    if (result) return result;
  }
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}

function mount(options = {}) {
  const state = {
    slots: [],
    index: 0,
    mounted: true,
    confirmed: 0,
    cancelled: 0,
    props: {
      title: 'Reset card?',
      children: 'This will erase the card.',
      onConfirm: () => state.confirmed++,
      onCancel: () => state.cancelled++,
      ...options,
    },
    render() {
      rendering = state;
      state.index = 0;
      state.tree = ConfirmPopup(state.props);
      rendering = undefined;
      return state.tree;
    },
    buttons() {
      return find(state.render(), node => node.type === 'buttons').props
        .children;
    },
    confirm() {
      state.buttons()[0].props.onClick();
      state.render();
    },
    cancel() {
      state.buttons()[1].props.onClick();
    },
    unmount() {
      state.mounted = false;
      state.slots = [];
    },
  };
  state.render();
  return state;
}

for (const confirmText of [
  ['I understand, add card', 'Confirm'],
  ['Review', 'I understand', 'Reset card'],
]) {
  test(`${confirmText.length} confirmation labels advance one per click and confirm only on the last click`, () => {
    const state = mount({confirmText, confirmColor: 'danger'});
    for (const [index, label] of confirmText.entries()) {
      assert.equal(textOf(state.buttons()[0]), label);
      assert.equal(state.buttons()[0].props.color, 'danger');
      assert.equal(state.confirmed, 0);
      state.confirm();
      assert.equal(state.confirmed, index === confirmText.length - 1 ? 1 : 0);
      assert.equal(state.cancelled, 0);
    }
    assert.equal(
      textOf(find(state.tree, node => node.type === 'details-title')),
      'Reset card?',
    );
    assert.equal(
      textOf(find(state.tree, node => node.type === 'description')),
      'This will erase the card.',
    );
  });
}

for (const stage of [0, 1, 2]) {
  test(`Cancel at confirmation stage ${stage + 1} never invokes onConfirm`, () => {
    const state = mount({confirmText: ['Review', 'I understand', 'Confirm']});
    for (let index = 0; index < stage; index++) state.confirm();
    assert.equal(textOf(state.buttons()[1]), 'Cancel');
    state.cancel();
    assert.equal(state.cancelled, 1);
    assert.equal(state.confirmed, 0);
  });
}

test('dismissing the second confirmation stage cancels without confirming', () => {
  const state = mount({confirmText: ['I understand', 'Confirm']});
  state.confirm();
  assert.equal(textOf(state.buttons()[0]), 'Confirm');
  assert.equal(state.tree.props.initialFocus, 'dialog');
  state.tree.props.onDismiss();
  assert.equal(state.cancelled, 1);
  assert.equal(state.confirmed, 0);
});

test('remounting after cancellation starts from the first confirmation label', () => {
  const confirmText = ['I understand, add card', 'Confirm'];
  const first = mount({confirmText});
  first.confirm();
  assert.equal(textOf(first.buttons()[0]), 'Confirm');
  first.cancel();
  first.unmount();

  const second = mount({confirmText});
  assert.equal(textOf(second.buttons()[0]), 'I understand, add card');
  second.confirm();
  assert.equal(second.confirmed, 0);
  assert.equal(textOf(second.buttons()[0]), 'Confirm');
  second.confirm();
  assert.equal(second.confirmed, 1);
  assert.equal(first.confirmed, 0);
  assert.equal(first.cancelled, 1);
});

test('a string confirmation label preserves the single-click action and custom cancellation label', () => {
  const state = mount({
    confirmText: 'Delete',
    cancelText: 'Keep',
    confirmColor: 'warning',
  });
  assert.equal(textOf(state.buttons()[0]), 'Delete');
  assert.equal(state.buttons()[0].props.color, 'warning');
  assert.equal(textOf(state.buttons()[1]), 'Keep');
  state.confirm();
  assert.equal(state.confirmed, 1);
  assert.equal(state.cancelled, 0);
});

for (const confirmText of [undefined, []]) {
  test(`${confirmText === undefined ? 'omitting confirmation text' : 'an empty label array'} keeps the default single-click Confirm action`, () => {
    const state = mount({confirmText});
    assert.equal(textOf(state.buttons()[0]), 'Confirm');
    assert.equal(state.buttons()[0].props.color, 'primary');
    assert.equal(textOf(state.buttons()[1]), 'Cancel');
    state.confirm();
    assert.equal(state.confirmed, 1);
    assert.equal(state.cancelled, 0);
  });
}
