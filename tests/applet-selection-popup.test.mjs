import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

import {validateCardAlias} from '../.bld/app/@lib/monoid/card-alias.js';

let fixture;
mock.module('react', {
  namedExports: {
    useState(initial) {
      const owner = fixture;
      const slot = (owner.slots[owner.index++] ??= {
        value: typeof initial === 'function' ? initial() : initial,
      });
      return [
        slot.value,
        value => {
          slot.value = value;
        },
      ];
    },
    useRef: initial => (fixture.slots[fixture.index++] ??= {current: initial}),
    useEffect: () => {},
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
mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {
    APPLET_NAMES: {},
    getAppletCatalog: () => [],
    validateCardAlias,
  },
});
mock.module('../.bld/app/@lib/otp-authority.js', {
  namedExports: {
    getDefaultInstallationAuthorityUrl: () => '',
    resolveOTPAuthorityInstallationOptions: async () =>
      assert.fail('Authority is disabled'),
  },
});
for (const [path, names] of [
  ['button', ['Button']],
  [
    'details-popup',
    [
      'DetailsPopup',
      'DetailsPopupDivider',
      'DetailsPopupSection',
      'DetailsPopupTitle',
    ],
  ],
  ['info-section', ['InfoSectionItem', 'InfoSectionItemLabel']],
  ['input', ['PopupInput']],
  ['message-content', ['InfoMessage']],
  ['toggle', ['Toggle']],
])
  mock.module(`../.bld/app/@components/@ui/${path}.js`, {
    namedExports: Object.fromEntries(names.map(name => [name, name])),
  });
const {AppletSelectionPopup} = await import(
  '../.bld/app/@components/views/card/applet-selection-popup.js'
);
function find(node, predicate) {
  if (!node) return;
  if (predicate(node)) return node;
  for (const child of Array.isArray(node) ? node : [node.props?.children]) {
    const result = find(child, predicate);
    if (result) return result;
  }
}
function mount(options = {}) {
  const state = {slots: [], index: 0, installed: []};
  state.render = () => {
    fixture = state;
    state.index = 0;
    return AppletSelectionPopup({
      selected: [],
      onChange() {},
      onDismiss() {},
      onInstall: (...args) => state.installed.push(args),
      ...options,
    });
  };
  state.aliasToggle = () =>
    find(state.render(), node => node.props?.children === 'Alias');
  state.input = () => {
    state.aliasToggle()?.props.onChange(true);
    return find(
      state.render(),
      node => node.props?.['aria-label'] === 'Card alias',
    );
  };
  state.button = () => find(state.render(), node => node.type === 'Button');
  state.install = async () => {
    find(state.render(), node => node.type === 'Button').props.onClick();
    await new Promise(resolve => setImmediate(resolve));
  };
  return state;
}

test('initial Identity installation accepts an optional exact UTF-8 alias without maxLength', async () => {
  const state = mount();
  assert.equal(state.input().props.maxLength, undefined);
  const alias = '😀'.repeat(16);
  state.input().props.onChange({target: {value: alias}});
  await state.install();
  assert.deepEqual(state.installed, [[{}, alias]]);
});

test('alias validation stops installation before passing options', async () => {
  const state = mount();
  state.input().props.onChange({target: {value: '中'.repeat(22)}});
  await state.install();
  assert.deepEqual(state.installed, []);
  assert.match(
    find(state.render(), node => node.type === 'InfoMessage').props.children,
    /64 UTF-8 bytes/,
  );
});

test('the alias switch reveals its input and blocks an empty alias', async () => {
  const state = mount();
  assert.equal(
    find(state.render(), node => node.props?.['aria-label'] === 'Card alias'),
    undefined,
  );
  await state.install();
  assert.deepEqual(state.installed, [[{}, undefined]]);
  assert.equal(state.input().props.placeholder, 'Enter card alias');
  assert.equal(state.button().props.disabled, true);
});

test('retained Identity and fresh installation do not offer an alias override', () => {
  assert.equal(
    mount({
      installation: {identity: {installed: true}, monoid: {installed: true}},
    }).input(),
    undefined,
  );
  assert.equal(mount({fresh: true}).input(), undefined);
});
