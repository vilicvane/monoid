import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AccountSelection,
  BrowserFlow,
  LoginError,
  restoreFlow,
} from '../src/flow.mjs';

function storage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}

test('flow restoration scrubs the URL before storage and rejects malformed replacements', () => {
  const saved = storage();
  const order = [];
  const originalSet = saved.setItem;
  saved.setItem = (key, value) => {
    order.push('stored');
    originalSet(key, value);
  };
  const history = {
    replaceState: (_, __, path) => {
      order.push('scrubbed');
      assert.equal(path, '/api/authority/login');
    },
  };
  const flow = 'a'.repeat(43);
  assert.equal(
    restoreFlow(
      {search: `?flow=${flow}`, pathname: '/api/authority/login'},
      history,
      saved,
    ),
    flow,
  );
  assert.deepEqual(order, ['scrubbed', 'stored']);
  assert.equal(
    restoreFlow({search: '', pathname: '/api/authority/login'}, history, saved),
    flow,
  );
  assert.equal(
    restoreFlow(
      {search: '?flow=invalid', pathname: '/api/authority/login'},
      history,
      saved,
    ),
    null,
  );
  assert.equal(
    restoreFlow({search: '', pathname: '/api/authority/login'}, history, saved),
    null,
  );
});

test('complete and cancel cannot concurrently issue two browser completions', async () => {
  let resolve;
  const pending = new Promise(done => {
    resolve = done;
  });
  const calls = [];
  const flow = new BrowserFlow(
    'a'.repeat(43),
    storage(),
    async (url, options) => {
      calls.push({url, options});
      return pending;
    },
  );
  const completing = flow.finish('complete', 'provider-token');
  assert.equal(await flow.finish('cancel'), null);
  resolve(
    Response.json({
      redirectUrl: 'app.monoid://authority/callback?code=one&state=two',
    }),
  );
  assert.equal(
    await completing,
    'app.monoid://authority/callback?code=one&state=two',
  );
  assert.equal(await flow.finish('complete', 'provider-token'), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(new URL(calls[0].url, 'https://monoid.app').search, '');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    flow: 'a'.repeat(43),
    token: 'provider-token',
  });
});

test('a failed request can be retried without clearing another tab flow', async () => {
  const saved = storage();
  const older = 'a'.repeat(43);
  const newer = 'b'.repeat(43);
  const history = {replaceState() {}};
  restoreFlow(
    {search: `?flow=${newer}`, pathname: '/api/authority/login'},
    history,
    saved,
  );
  let attempt = 0;
  const flow = new BrowserFlow(older, saved, async () => {
    return ++attempt === 1
      ? Response.json({error: 'reown_unavailable'}, {status: 502})
      : Response.json({
          redirectUrl: 'app.monoid://authority/callback?code=one&state=two',
        });
  });
  await assert.rejects(flow.finish('complete', 'token'), LoginError);
  assert.equal(flow.state, 'active');
  await flow.finish('complete', 'token');
  assert.equal(
    restoreFlow({search: '', pathname: '/api/authority/login'}, history, saved),
    newer,
  );
});

test('wallet changes and cancellation invalidate in-flight profile results', () => {
  const selection = new AccountSelection();
  selection.setConnection('eip155:1:0xAbC');
  const first = selection.revision;
  assert.equal(
    selection.accepts(first, {caip2Network: 'eip155:1', address: '0xabc'}),
    true,
  );
  assert.equal(
    selection.accepts(first, {caip2Network: 'eip155:10', address: '0xabc'}),
    false,
  );
  selection.setConnection('eip155:1:0xDEF');
  assert.equal(
    selection.accepts(first, {caip2Network: 'eip155:1', address: '0xabc'}),
    false,
  );
  const current = selection.revision;
  selection.stop();
  assert.equal(
    selection.accepts(current, {caip2Network: 'eip155:1', address: '0xdef'}),
    false,
  );
});
