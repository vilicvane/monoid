/* global globalThis */

import assert from 'node:assert/strict';
import {test} from 'node:test';

const {BitcoinApi, BitcoinBroadcastError} = await import(
  '../.bld/app/@lib/bitcoin-api.js'
);

const ADDRESS = 'bc1qtestaddress00000000000000000000000000000';
const TXID = 'ab'.repeat(32);
const BLOCK = 'cd'.repeat(32);
const STATUS = {
  confirmed: true,
  block_height: 800_000,
  block_hash: BLOCK,
  block_time: 1_700_000_000,
};

test('default fetch preserves the global receiver required by browsers', async context => {
  const fetch = context.mock.method(globalThis, 'fetch', async function (url) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    assert.equal(url, 'https://blockstream.info/api/blocks/tip/height');
    return new Response('800001');
  });
  assert.equal(await new BitcoinApi().getTipHeight(), 800001);
  assert.equal(fetch.mock.callCount(), 1);
});

test('address balances keep exact satoshis and pending outgoing funds negative', async () => {
  const api = new BitcoinApi('https://example.invalid', async () =>
    Response.json({
      address: ADDRESS,
      chain_stats: {
        funded_txo_sum: 1234567890123456,
        spent_txo_sum: 1234567890100000,
        tx_count: 12,
      },
      mempool_stats: {funded_txo_sum: 2000, spent_txo_sum: 5000, tx_count: 1},
    }),
  );
  assert.deepEqual(await api.getAddress(ADDRESS), {
    address: ADDRESS,
    confirmedBalance: 23456n,
    pendingBalance: -3000n,
    confirmedTransactionCount: 12,
    pendingTransactionCount: 1,
  });
});

test('unsafe, fractional, negative and duplicate UTXOs are rejected', async () => {
  for (const value of [
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
    -1,
    2100000000000001,
  ]) {
    const api = new BitcoinApi('https://example.invalid', async () =>
      Response.json([{txid: TXID, vout: 0, value, status: STATUS}]),
    );
    await assert.rejects(api.getUtxos(ADDRESS), /invalid data/);
  }
  const utxo = {txid: TXID, vout: 0, value: 1000, status: STATUS};
  const api = new BitcoinApi('https://example.invalid', async () =>
    Response.json([utxo, utxo]),
  );
  await assert.rejects(api.getUtxos(ADDRESS), /invalid data/);
});

test('malformed confirmed status and wrong address response are rejected', async () => {
  const api = new BitcoinApi('https://example.invalid', async () =>
    Response.json([
      {txid: TXID, vout: 0, value: 1000, status: {confirmed: true}},
    ]),
  );
  await assert.rejects(api.getUtxos(ADDRESS), /invalid data/);
  const mismatched = new BitcoinApi('https://example.invalid', async () =>
    Response.json({address: 'other'}),
  );
  await assert.rejects(mismatched.getAddress(ADDRESS), /invalid data/);
});

test('fee estimates round up and preserve target ordering without silent fallback', async () => {
  const api = new BitcoinApi('https://example.invalid', async () =>
    Response.json({1: 2.2, 3: 3.01, 6: 1.2}),
  );
  assert.deepEqual(await api.getFeeRates(), {fast: 4, normal: 4, economy: 2});
  const unavailable = new BitcoinApi('https://example.invalid', async () =>
    Response.json({}),
  );
  await assert.rejects(unavailable.getFeeRates(), /invalid data/);
});

test('raw transaction downloads deduplicate shared funding txids', async () => {
  const paths = [];
  const api = new BitcoinApi('https://example.invalid/', async url => {
    paths.push(url);
    return new Response('01000000');
  });
  assert.deepEqual(
    await api.getPreviousTransactions([{txid: TXID}, {txid: TXID}]),
    {[TXID]: '01000000'},
  );
  assert.deepEqual(paths, [`https://example.invalid/tx/${TXID}/hex`]);
});

test('broadcast response mismatch and lost response are unknown outcomes', async () => {
  for (const fetcher of [
    async () => new Response('00'.repeat(32)),
    async () => {
      throw new TypeError('offline');
    },
  ]) {
    const api = new BitcoinApi('https://example.invalid', fetcher);
    await assert.rejects(
      api.broadcastTransaction('01000000', TXID),
      error =>
        error instanceof BitcoinBroadcastError &&
        error.outcome === 'unknown' &&
        error.txid === TXID,
    );
  }
});

test('HTTP 400 followed by index lookup 404 leaves broadcast outcome unknown', async () => {
  const api = new BitcoinApi(
    'https://example.invalid',
    async (_url, options) =>
      new Response('bad transaction', {
        status: options.method === 'POST' ? 400 : 404,
      }),
  );
  await assert.rejects(
    api.broadcastTransaction('01000000', TXID),
    error =>
      error instanceof BitcoinBroadcastError &&
      error.outcome === 'unknown' &&
      error.txid === TXID,
  );
});

test('an already accepted broadcast is recognized when the server rejects a duplicate submission', async () => {
  const api = new BitcoinApi(
    'https://example.invalid',
    async (_url, options) => {
      if (options.method === 'POST')
        return new Response('already known', {status: 400});
      return Response.json({
        txid: TXID,
        vin: [{is_coinbase: true}],
        vout: [{value: 1000, scriptpubkey: ''}],
        fee: 0,
        status: STATUS,
      });
    },
  );
  assert.equal(await api.broadcastTransaction('01000000', TXID), TXID);
});

test('broadcast sends raw hex and checks returned transaction id', async () => {
  const api = new BitcoinApi(
    'https://example.invalid',
    async (url, options) => {
      assert.equal(url, 'https://example.invalid/tx');
      assert.equal(options.method, 'POST');
      assert.equal(options.body, '01000000');
      return new Response(TXID);
    },
  );
  assert.equal(await api.broadcastTransaction('01000000', TXID), TXID);
});

test('timeout and caller cancellation remain distinct from a zero balance', async () => {
  const fetcher = (_url, {signal}) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    });
  const api = new BitcoinApi('https://example.invalid', fetcher, 5);
  await assert.rejects(api.getAddress(ADDRESS), /timed out/);
  const controller = new AbortController();
  const loading = api.getAddress(ADDRESS, controller.signal);
  controller.abort();
  await assert.rejects(loading, error => error.name === 'AbortError');
});

test('network errors retain their original cause for diagnosis', async () => {
  const cause = new TypeError('Failed to fetch');
  const api = new BitcoinApi('https://example.invalid', async () => {
    throw cause;
  });
  await assert.rejects(
    api.getTipHeight(),
    error =>
      error.message.includes('Could not reach the Bitcoin service') &&
      error.cause === cause,
  );
});
