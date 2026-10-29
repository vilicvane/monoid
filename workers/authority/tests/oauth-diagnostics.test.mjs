import assert from 'node:assert/strict';
import {test} from 'node:test';
import {googleIdentity} from '../.bld/google.js';
import {githubIdentity} from '../.bld/github-oauth.js';
import {environment} from './login-fixture.mjs';

const code = 'private-code+/value';
const verifier = 'private-verifier-value';
const token = 'private-provider-token';
const env = environment(null);

function exchange(provider, response) {
  const fetcher = async () => response;
  return provider === 'google'
    ? googleIdentity(code, verifier, 'private-nonce', env, fetcher)
    : githubIdentity(code, verifier, env, fetcher);
}

function warning(mock) {
  assert.equal(mock.mock.calls.length, 1);
  const args = mock.mock.calls[0].arguments;
  assert.equal(args.length, 1);
  assert.equal(typeof args[0], 'string');
  assert.doesNotMatch(args[0], /[\r\n\u2028\u2029]/);
  assert.ok(args[0].startsWith('[oauth] '));
  for (const secret of [
    code,
    verifier,
    token,
    env.GOOGLE_CLIENT_SECRET,
    env.GITHUB_CLIENT_SECRET,
  ]) {
    assert.ok(!args[0].includes(secret));
    assert.ok(!args[0].includes(encodeURIComponent(secret)));
  }
  return JSON.parse(args[0].slice('[oauth] '.length));
}

for (const provider of ['google', 'github'])
  for (const format of ['json', 'form'])
    test(`${provider} token errors log only safe ${format} fields and keep the public error`, async t => {
      const warn = t.mock.method(console, 'warn', () => {});
      const fields = {
        error: 'invalid_grant',
        error_description: 'The authorization code has expired.',
        error_uri: 'https://example.test/private-details',
        code,
        code_verifier: verifier,
        client_secret: env[provider.toUpperCase() + '_CLIENT_SECRET'],
        access_token: token,
        id_token: 'private-id-token',
        refresh_token: 'private-refresh-token',
      };
      const response =
        format === 'json'
          ? Response.json(fields, {status: 400})
          : new Response(new URLSearchParams(fields), {status: 401});
      await assert.rejects(exchange(provider, response), {
        status: 502,
        code: `${provider}_authorization_failed`,
      });
      assert.deepEqual(warning(warn), {
        provider,
        status: format === 'json' ? 400 : 401,
        error: fields.error,
        error_description: fields.error_description,
      });
    });

test('GitHub OAuth error with HTTP 200 is also diagnosed without retaining returned tokens', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  await assert.rejects(
    exchange(
      'github',
      Response.json({
        error: 'bad_verification_code',
        error_description: 'The code passed is incorrect or expired.',
        access_token: token,
      }),
    ),
    {status: 502, code: 'github_authorization_failed'},
  );
  assert.deepEqual(warning(warn), {
    provider: 'github',
    status: 200,
    error: 'bad_verification_code',
    error_description: 'The code passed is incorrect or expired.',
  });
});

test('provider text is redacted before length caps and cannot inject log lines', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const description = [
    code,
    encodeURIComponent(code),
    verifier,
    env.GOOGLE_CLIENT_SECRET,
    token,
    'private-id-token',
    'private-refresh-token',
  ].join(' ');
  await assert.rejects(
    exchange(
      'google',
      Response.json(
        {
          error: 'invalid_grant' + 'x'.repeat(200),
          error_description: description + '\r\n\u2028\u2029' + 'y'.repeat(600),
          access_token: token,
          id_token: 'private-id-token',
          refresh_token: 'private-refresh-token',
        },
        {status: 400},
      ),
    ),
    {code: 'google_authorization_failed'},
  );
  const log = warning(warn);
  assert.equal(log.error.length, 128);
  assert.equal(log.error_description.length, 512);
  assert.match(log.error_description, /\[redacted\]/);
  assert.doesNotMatch(log.error_description, /private-/);
});

test('unparseable, non-string and oversized error bodies log status without dumping contents', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  for (const body of [
    '<html>private-raw-body</html>',
    '{"error":"private-incomplete-json',
    'null',
    '["private-array"]',
    JSON.stringify({error: {token}, error_description: [code]}),
    JSON.stringify({
      error: 'invalid_grant',
      error_description: 'x'.repeat(17000),
    }),
    'error=invalid_grant&error_description=' + 'x'.repeat(17000),
  ]) {
    warn.mock.resetCalls();
    await assert.rejects(
      exchange('google', new Response(body, {status: 503})),
      {
        code: 'google_authorization_failed',
      },
    );
    assert.deepEqual(warning(warn), {provider: 'google', status: 503});
  }
});

test('a failed error-body stream preserves the status warning and public error', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error('private-stream-error'));
      },
    }),
    {status: 502},
  );
  await assert.rejects(exchange('github', response), {
    code: 'github_authorization_failed',
  });
  assert.deepEqual(warning(warn), {provider: 'github', status: 502});
});
