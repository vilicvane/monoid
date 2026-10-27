import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

mock.module('react', {namedExports: {useRef: value => ({current: value})}});
mock.module('react/jsx-runtime', {
  namedExports: {
    jsx: (type, props) =>
      typeof type === 'function' ? type(props) : {type, props},
    jsxs: (type, props) =>
      typeof type === 'function' ? type(props) : {type, props},
  },
});
mock.module('styled-components', {
  namedExports: {
    styled: Object.assign(type => () => type, {
      input: () => 'input',
      div: () => 'div',
      button: () => 'button',
    }),
  },
});
mock.module('lucide-react', {namedExports: {RotateCcw: 'reset-icon'}});
mock.module('../.bld/app/@components/@animations.js', {
  namedExports: {selectionTransition: {duration: 200, easing: 'linear'}},
});
mock.module('../.bld/app/@components/@ui/app-icon.js', {
  namedExports: {AppIcon: 'icon'},
});
const {InputWithAction, ResettableInput} = await import(
  '../.bld/app/@components/@ui/input.js'
);

test('reset keeps input props and resets before returning focus to the input', () => {
  const events = [];
  const onChange = () => {};
  const tree = ResettableInput({
    value: 'edited',
    onChange,
    onReset: () => events.push('reset'),
    resetDisabled: false,
  });
  const [input, button] = tree.props.children;
  input.props.ref.current = {focus: () => events.push('focus')};
  assert.equal(input.props.value, 'edited');
  assert.equal(input.props.onChange, onChange);
  assert.equal(button.props['aria-label'], 'Reset to default');
  assert.equal(button.props.title, 'Reset to default');
  button.props.onClick();
  assert.deepEqual(events, ['reset', 'focus']);
});

test('action inherits disabled and invalid input states while reset can be disabled independently', () => {
  for (const props of [
    {disabled: true, resetDisabled: false},
    {disabled: false, resetDisabled: true},
  ]) {
    const tree = ResettableInput({
      ...props,
      'aria-invalid': true,
      onReset: () => {},
    });
    const button = tree.props.children[1];
    assert.equal(button.props.disabled, true);
    assert.equal(button.props.$invalid, true);
  }
});

test('input accepts an optional trailing action without forcing input focus', () => {
  const calls = [];
  const tree = InputWithAction({
    action: {
      label: 'Choose bundle',
      icon: 'list',
      onClick: () => calls.push('choose'),
    },
  });
  tree.props.children[0].props.ref.current = {
    focus: () => assert.fail('Picker must not focus the input'),
  };
  const button = tree.props.children[1];
  assert.equal(button.props['aria-label'], 'Choose bundle');
  assert.equal(button.props.children.props.icon, 'list');
  button.props.onClick();
  assert.deepEqual(calls, ['choose']);
  assert.equal(
    InputWithAction({placeholder: 'Bundle name'}).props.children[1],
    undefined,
  );
});
