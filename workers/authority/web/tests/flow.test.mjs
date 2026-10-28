import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserFlow, LoginError, restoreFlow} from '../src/flow.mjs';

function storage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}

test('browser flow follows the production root or configured development base', async () => {
  for (const base of ['/', '/api/authority/']) {
    const requests = [];
    const flow = new BrowserFlow(
      'a'.repeat(43),
      storage(),
      async (url, options) => {
        requests.push({url, options});
        return Response.json({redirectUrl: 'app.monoid://authority/callback'});
      },
      base,
    );
    await flow.context();
    await flow.finish('cancel');
    assert.equal(
      requests[0].url,
      `${base}auth/login/context?flow=${flow.flow}`,
    );
    assert.equal(requests[1].url, `${base}auth/login/cancel`);
    assert.equal(requests[1].options.credentials, 'same-origin');
    assert.equal(requests[1].options.redirect, 'error');
  }
});

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
  const completing = flow.finish('complete');
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
  assert.equal(await flow.finish('complete'), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(new URL(calls[0].url, 'https://monoid.app').search, '');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    flow: 'a'.repeat(43),
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
      ? Response.json({error: 'google_unavailable'}, {status: 502})
      : Response.json({
          redirectUrl: 'app.monoid://authority/callback?code=one&state=two',
        });
  });
  await assert.rejects(flow.finish('complete'), LoginError);
  assert.equal(flow.state, 'active');
  await flow.finish('complete');
  assert.equal(
    restoreFlow({search: '', pathname: '/api/authority/login'}, history, saved),
    newer,
  );
});
