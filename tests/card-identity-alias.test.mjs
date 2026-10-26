import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  setCardAlias,
  validateCardAlias,
} from '../.bld/app/@lib/monoid/card-alias.js';

const hello = {
  version: 1,
  id: Uint8Array.of(1, 2, 3, 4),
  publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(1)),
  alias: false,
  allowPeerExtension: false,
  authority: false,
  bundle: false,
  pins: {access: 5, secret: 5},
};

test('card aliases count UTF-8 bytes without normalization or a character limit', () => {
  for (const alias of [
    '',
    'a'.repeat(64),
    `${'中'.repeat(21)}x`,
    '😀'.repeat(16),
    '  Travel  ',
  ])
    assert.doesNotThrow(() => validateCardAlias(alias));
  for (const alias of ['a'.repeat(65), '中'.repeat(22), '😀'.repeat(17)])
    assert.throws(() => validateCardAlias(alias), /64 UTF-8 bytes/);
});

for (const alias of ['旅行卡 😀', '']) {
  test(`set card alias verifies the same Identity and exact value (${alias || 'clear'})`, async () => {
    const before = {...hello, alias: 'Old'};
    const calls = [];
    const result = await setCardAlias(
      {
        setAlias: async request => calls.push(request),
        hello: async () => ({...hello, alias: alias || false}),
      },
      before,
      alias,
      new AbortController().signal,
    );
    assert.deepEqual(calls, [{alias}]);
    assert.equal(result.alias, alias || false);
  });
}

test('an uncertain alias write is not replayed and an explicit retry reconciles Hello', async () => {
  let writes = 0;
  const failure = new Error('Lost acknowledgement');
  const applet = {
    setAlias: async () => {
      writes++;
      throw failure;
    },
  };
  await assert.rejects(
    setCardAlias(applet, hello, 'Travel', new AbortController().signal),
    error => error === failure,
  );
  assert.equal(writes, 1);
  await setCardAlias(
    applet,
    {...hello, alias: 'Travel'},
    'Travel',
    new AbortController().signal,
  );
  assert.equal(writes, 1);
});

test('alias verification rejects a mismatch or changed Identity, and cancellation prevents writing', async () => {
  for (const after of [
    hello,
    {
      ...hello,
      alias: 'Travel',
      publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(2)),
    },
  ]) {
    await assert.rejects(
      setCardAlias(
        {setAlias: async () => {}, hello: async () => after},
        hello,
        'Travel',
        new AbortController().signal,
      ),
    );
  }
  await assert.rejects(
    setCardAlias(
      {setAlias: () => assert.fail('No write after cancellation')},
      hello,
      'Travel',
      AbortSignal.abort(),
    ),
    {name: 'AbortError'},
  );
});
