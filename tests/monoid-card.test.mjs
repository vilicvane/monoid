import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {after, mock, test} from 'node:test';

const assets = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier.endsWith('.svg')
      ? {url: new URL(specifier, context.parentURL).href, shortCircuit: true}
      : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    return url.endsWith('.svg')
      ? {format: 'module', source: 'export default "icon";', shortCircuit: true}
      : nextLoad(url, context);
  },
});
after(() => assets.deregister());
let state;
mock.module('react', {
  namedExports: {
    useState: initial => [state ?? initial, value => (state = value)],
  },
});
mock.module('react/jsx-runtime', {
  namedExports: {
    jsx: (type, props) => ({type, props}),
    jsxs: (type, props) => ({type, props}),
  },
});
mock.module('styled-components', {
  namedExports: {styled: new Proxy({}, {get: (_target, tag) => () => tag})},
});
const {MonoidCard} = await import(
  '../.bld/app/@components/@monoid/monoid-card.js'
);

function text(node) {
  if (typeof node === 'string') return node;
  if (!node) return '';
  return (Array.isArray(node) ? node : [node.props?.children])
    .map(text)
    .join('');
}

for (const [props, lines] of [
  [
    {alias: 'Travel', subtitle: 'bundle', description: 'scan to read'},
    ['Travel', 'bundle', 'scan to read'],
  ],
  [
    {alias: '旅行卡', description: 'scan to install'},
    ['旅行卡', 'scan to install'],
  ],
  [{alias: 'a'.repeat(64)}, ['a'.repeat(64)]],
  [
    {alias: false, subtitle: 'bundle', description: 'ready'},
    ['01020304', 'bundle', 'ready'],
  ],
  [{description: 'complete'}, ['01020304', 'complete']],
]) {
  test(`card preview shows the alias in place of the ID: ${lines.join(' / ')}`, () => {
    state = undefined;
    const tree = MonoidCard({id: '01020304', ...props});
    const label = tree.props.children.find(node => node?.type === 'span');
    assert.deepEqual(label.props.children.filter(Boolean).map(text), lines);
  });
}

test('a card without its own tap action toggles between alias and ID', () => {
  state = undefined;
  const render = () =>
    MonoidCard({id: '01020304', alias: 'Travel', aliasToggle: true})
      .props.children.find(node => node?.type === 'span')
      .props.children.filter(Boolean)[0];
  const name = render();
  assert.equal(name.type, 'button');
  assert.equal(text(name), 'Travel');
  let stopped = false;
  name.props.onClick({stopPropagation: () => (stopped = true)});
  assert.equal(stopped, true);
  state = typeof state === 'function' ? state(false) : state;
  assert.equal(text(render()), '01020304');
});
