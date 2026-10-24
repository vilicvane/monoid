import assert from 'node:assert/strict';
import {test} from 'node:test';
import {LoginLifecycle} from '../src/login-lifecycle.mjs';

const walletA = {caip2Network: 'eip155:1', address: `0x${'ab'.repeat(20)}`};
const walletB = {caip2Network: 'eip155:1', address: `0x${'cd'.repeat(20)}`};
const connection = wallet => `${wallet.caip2Network}:${wallet.address}`;

test('explicit logout blocks both pending and newly received provider sessions until user resumes', () => {
  const lifecycle = new LoginLifecycle();
  lifecycle.setConnection(connection(walletA));
  const pending = lifecycle.snapshot();
  lifecycle.signOut();
  assert.equal(lifecycle.accepts(pending, walletA), false);
  assert.equal(lifecycle.accepts(lifecycle.snapshot(), walletA), false);
  lifecycle.resume();
  assert.equal(lifecycle.accepts(pending, walletA), false);
  assert.equal(lifecycle.accepts(lifecycle.snapshot(), walletA), true);
});

test('wallet switches invalidate in-flight identity checks and reject a stale stored JWT identity', () => {
  const lifecycle = new LoginLifecycle();
  lifecycle.setConnection(connection(walletA));
  const pending = lifecycle.snapshot();
  lifecycle.setConnection(connection(walletB));
  assert.equal(lifecycle.accepts(pending, walletA), false);
  assert.equal(lifecycle.accepts(lifecycle.snapshot(), walletA), false);
  assert.equal(lifecycle.accepts(lifecycle.snapshot(), walletB), true);
  lifecycle.setConnection(undefined);
  assert.equal(lifecycle.accepts(lifecycle.snapshot(), walletB), false);
});

test('connection matching respects EVM casing, chain identity and non-EVM address casing', () => {
  const lifecycle = new LoginLifecycle();
  lifecycle.setConnection(`eip155:1:0x${'AB'.repeat(20)}`);
  assert.equal(lifecycle.accepts(lifecycle.snapshot(), walletA), true);
  assert.equal(
    lifecycle.accepts(lifecycle.snapshot(), {
      ...walletA,
      caip2Network: 'eip155:10',
    }),
    false,
  );
  lifecycle.setConnection('solana:mainnet:AbCd');
  assert.equal(
    lifecycle.accepts(lifecycle.snapshot(), {
      caip2Network: 'solana:mainnet',
      address: 'abcd',
    }),
    false,
  );
  assert.equal(
    lifecycle.accepts(lifecycle.snapshot(), {
      caip2Network: 'solana:mainnet',
      address: 'AbCd',
    }),
    true,
  );
});

test('remembered logout prevents automatic restoration after reload', () => {
  const lifecycle = new LoginLifecycle(true);
  lifecycle.setConnection(connection(walletA));
  assert.equal(lifecycle.accepts(lifecycle.snapshot(), walletA), false);
  lifecycle.resume();
  assert.equal(lifecycle.accepts(lifecycle.snapshot(), walletA), true);
});
