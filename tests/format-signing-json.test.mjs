import assert from 'node:assert/strict';
import {test} from 'node:test';

const {formatSigningJSON} = await import(
  '../.bld/app/@lib/format-signing-json.js'
);

test('shows invisible formatting controls without changing signed JSON values', () => {
  const value = {
    name: 'safe\u202e dangerous',
    nested: [{note: 'zero\u200bwidth\u{e0001}'}],
    unicode: '登录 Monoid 👋',
    amount: '9007199254740993',
  };
  const text = formatSigningJSON(value);
  assert.doesNotMatch(text, /\p{Cf}/u);
  assert.match(text, /\\u202e/);
  assert.match(text, /\\u200b/);
  assert.match(text, /\\udb40\\udc01/);
  assert.ok(text.includes(value.unicode));
  assert.deepEqual(JSON.parse(text), value);
});

test('type and field labels cannot inject new display lines or hidden text direction', () => {
  const name = 'Field\nInjected\u202e';
  const text = formatSigningJSON(name).slice(1, -1);
  assert.equal(text, 'Field\\nInjected\\u202e');
  assert.equal(JSON.parse(`"${text}"`), name);
});
