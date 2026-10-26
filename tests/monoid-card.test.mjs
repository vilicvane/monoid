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
    ['Travel', 'scan to read'],
  ],
  [
    {alias: '旅行卡', description: 'scan to install'},
    ['旅行卡', 'scan to install'],
  ],
  [{alias: 'a'.repeat(64)}, ['a'.repeat(64)]],
  [
    {alias: false, subtitle: 'bundle', description: 'ready'},
    ['bundle', 'ready'],
  ],
  [{description: 'complete'}, ['complete']],
]) {
  test(`card preview shows alias or subtitle above the unchanged status: ${lines.join(' / ')}`, () => {
    const tree = MonoidCard({id: '01020304', ...props});
    const label = tree.props.children.find(node => node?.type === 'span');
    assert.deepEqual(label.props.children.filter(Boolean).map(text), [
      '01020304',
      ...lines,
    ]);
    if (props.description)
      assert.equal(label.props.children[2].props.children, props.description);
  });
}
