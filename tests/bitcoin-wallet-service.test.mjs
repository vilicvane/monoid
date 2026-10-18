import assert from 'node:assert/strict';
import {test} from 'node:test';

const {BitcoinWalletService} = await import(
  '../.bld/app/@services/bitcoin-wallet-service.js'
);
const {BitcoinBroadcastError} = await import('../.bld/app/@lib/bitcoin-api.js');

const ADDRESS = 'bc1qtestaddress00000000000000000000000000000';
const OTHER = 'bc1qotheraddress0000000000000000000000000000';
const TXID = 'ab'.repeat(32);
const STATUS = {
  confirmed: true,
  blockHeight: 800,
  blockHash: 'cd'.repeat(32),
  blockTime: 1700000000,
};
const UTXO = {txid: TXID, vout: 0, value: 10000n, status: STATUS};

function transaction(txid = TXID) {
  return {
    txid,
    inputs: [
      {
        coinbase: false,
        previousOutput: {address: ADDRESS, value: 30000n, script: ''},
      },
    ],
    outputs: [
      {address: ADDRESS, value: 10000n, script: ''},
      {address: OTHER, value: 19000n, script: ''},
    ],
    fee: 1000n,
    status: STATUS,
  };
}

function api(overrides = {}) {
  return {
    async getAddress(address) {
      return {
        address,
        confirmedBalance: 10000n,
        pendingBalance: 0n,
        confirmedTransactionCount: 1,
        pendingTransactionCount: 0,
      };
    },
    async getUtxos() {
      return [UTXO];
    },
    async getTransactions() {
      return [transaction()];
    },
    async getTipHeight() {
      return 1000;
    },
    async getTransaction() {
      return transaction();
    },
    async broadcastTransaction(_hex, txid) {
      return txid;
    },
    ...overrides,
  };
}

function historyTransaction(index) {
  return {
    ...transaction(index.toString(16).padStart(64, '0')),
    status: {...STATUS, blockHeight: 950 - index},
  };
}

test('wallet history measures net flow including change and fee', async () => {
  const service = new BitcoinWalletService(api());
  await service.refresh(ADDRESS);
  const state = service.get(ADDRESS);
  assert.equal(state.status, 'ready');
  assert.equal(state.snapshot.spendableBalance, 10000n);
  assert.deepEqual(state.snapshot.transactions[0], {
    txid: TXID,
    netSats: -20000n,
    receivedSats: 10000n,
    spentSats: 30000n,
    fee: 1000n,
    status: STATUS,
    confirmations: 201,
  });
  assert.equal(service.get(OTHER).snapshot, undefined);
});

test('offline wallet is an explicit error with no fabricated zero balance', async () => {
  const service = new BitcoinWalletService(
    api({
      async getAddress() {
        throw new Error('Offline');
      },
    }),
  );
  await service.refresh(ADDRESS);
  assert.equal(service.get(ADDRESS).status, 'error');
  assert.equal(service.get(ADDRESS).error, 'Offline');
  assert.equal(service.get(ADDRESS).snapshot, undefined);
});

test('older refresh cannot overwrite a newer result even when the request ignores cancellation', async () => {
  const first = Promise.withResolvers();
  let calls = 0;
  const service = new BitcoinWalletService(
    api({
      async getAddress(address) {
        if (!calls++) return first.promise;
        return {
          address,
          confirmedBalance: 10000n,
          pendingBalance: 0n,
          pendingTransactionCount: 0,
        };
      },
    }),
  );
  const older = service.refresh(ADDRESS);
  await service.refresh(ADDRESS);
  first.resolve({
    address: ADDRESS,
    confirmedBalance: 1n,
    pendingBalance: 0n,
    pendingTransactionCount: 0,
  });
  await older;
  assert.equal(service.get(ADDRESS).snapshot.confirmedBalance, 10000n);
});

test('immature coinbase and unconfirmed outputs are not available to spend', async () => {
  const immature = {...UTXO, status: {...STATUS, blockHeight: 950}};
  const pending = {...UTXO, txid: 'aa'.repeat(32), status: {confirmed: false}};
  const service = new BitcoinWalletService(
    api({
      async getUtxos() {
        return [immature, pending];
      },
      async getTransaction() {
        return {...transaction(), inputs: [{coinbase: true}]};
      },
    }),
  );
  await service.refresh(ADDRESS);
  assert.equal(service.get(ADDRESS).snapshot.spendableBalance, 0n);
  assert.deepEqual(service.get(ADDRESS).snapshot.utxos, []);
});

test('history paginates confirmed transactions and reports truncated mempool history', async () => {
  const initial = Array.from({length: 25}, (_, index) =>
    transaction(index.toString(16).padStart(64, '0')),
  );
  const next = transaction('ff'.repeat(32));
  const service = new BitcoinWalletService(
    api({
      async getAddress(address) {
        return {
          address,
          confirmedBalance: 10000n,
          pendingBalance: 0n,
          pendingTransactionCount: 51,
        };
      },
      async getTransactions(_address, cursor) {
        if (!cursor) return initial;
        assert.equal(cursor, initial.at(-1).txid);
        return [next];
      },
    }),
  );
  await service.refresh(ADDRESS);
  assert.equal(service.get(ADDRESS).snapshot.hasMore, true);
  assert.equal(service.get(ADDRESS).snapshot.pendingHistoryTruncated, true);
  await service.loadMore(ADDRESS);
  assert.equal(service.get(ADDRESS).snapshot.transactions.length, 26);
  assert.equal(service.get(ADDRESS).snapshot.hasMore, false);
});

test('automatic refresh joins latest transactions to paginated history and preserves its cursor', async () => {
  const history = Array.from({length: 51}, (_, index) =>
    historyTransaction(index + 1),
  );
  const oldPending = {
    ...transaction('aa'.repeat(32)),
    status: {confirmed: false},
  };
  const newPending = {
    ...transaction('bb'.repeat(32)),
    status: {confirmed: false},
  };
  const newlyConfirmed = {
    ...transaction('cc'.repeat(32)),
    status: {...STATUS, blockHeight: 1001},
  };
  let latest = [oldPending, ...history.slice(0, 25)];
  let tip = 1000;
  let balance = 10000n;
  const cursors = [];
  const service = new BitcoinWalletService(
    api({
      async getAddress(address) {
        return {
          address,
          confirmedBalance: balance,
          pendingBalance: -1000n,
          pendingTransactionCount: 1,
        };
      },
      async getTipHeight() {
        return tip;
      },
      async getTransactions(_address, cursor) {
        if (!cursor) return latest;
        cursors.push(cursor);
        return cursor === history[24].txid
          ? history.slice(25, 50)
          : history.slice(50);
      },
    }),
  );
  await service.refresh(ADDRESS);
  await service.loadMore(ADDRESS);
  latest = [newPending, newlyConfirmed, ...history.slice(0, 24)];
  tip = 1001;
  balance = 20000n;
  await service.refresh(ADDRESS, {preserveHistory: true});
  const snapshot = service.get(ADDRESS).snapshot;
  assert.deepEqual(
    snapshot.transactions.map(tx => tx.txid),
    [
      newPending.txid,
      newlyConfirmed.txid,
      ...history.slice(0, 50).map(tx => tx.txid),
    ],
  );
  assert.equal(
    new Set(snapshot.transactions.map(tx => tx.txid)).size,
    snapshot.transactions.length,
  );
  assert.equal(snapshot.transactions.at(-1).confirmations, 102);
  assert.equal(snapshot.confirmedBalance, 20000n);
  assert.equal(snapshot.hasMore, true);
  await service.loadMore(ADDRESS);
  assert.deepEqual(cursors, [history[24].txid, history[49].txid]);
  assert.equal(
    service.get(ADDRESS).snapshot.transactions.at(-1).txid,
    history[50].txid,
  );
  assert.equal(service.get(ADDRESS).snapshot.hasMore, false);
});

test('automatic refresh preserves a known history end without retaining stale pending transactions', async () => {
  const history = Array.from({length: 26}, (_, index) =>
    historyTransaction(index + 1),
  );
  const pending = {...transaction('aa'.repeat(32)), status: {confirmed: false}};
  let latest = [pending, ...history.slice(0, 25)];
  const service = new BitcoinWalletService(
    api({
      async getTransactions(_address, cursor) {
        return cursor ? history.slice(25) : latest;
      },
    }),
  );
  await service.refresh(ADDRESS);
  await service.loadMore(ADDRESS);
  latest = history.slice(0, 25);
  await service.refresh(ADDRESS, {preserveHistory: true});
  assert.deepEqual(
    service.get(ADDRESS).snapshot.transactions.map(tx => tx.txid),
    history.map(tx => tx.txid),
  );
  assert.equal(service.get(ADDRESS).snapshot.hasMore, false);
});

test('automatic refresh resets the loaded tail for a reorg, gap, ordering change or complete short page', async () => {
  const history = Array.from({length: 26}, (_, index) =>
    historyTransaction(index + 1),
  );
  const scenarios = [
    {
      latest: history
        .slice(0, 25)
        .map((tx, index) =>
          index === 0
            ? {...tx, status: {...tx.status, blockHash: 'ee'.repeat(32)}}
            : tx,
        ),
    },
    {
      latest: Array.from({length: 25}, (_, index) =>
        historyTransaction(100 + index),
      ),
    },
    {latest: [history[1], history[0], ...history.slice(2, 25)]},
    {latest: history.slice(0, 24)},
    {latest: history.slice(0, 25), tip: 999},
  ];
  for (const scenario of scenarios) {
    let latest = history.slice(0, 25);
    let tip = 1000;
    const service = new BitcoinWalletService(
      api({
        async getTipHeight() {
          return tip;
        },
        async getTransactions(_address, cursor) {
          return cursor ? history.slice(25) : latest;
        },
      }),
    );
    await service.refresh(ADDRESS);
    await service.loadMore(ADDRESS);
    latest = scenario.latest;
    tip = scenario.tip ?? tip;
    await service.refresh(ADDRESS, {preserveHistory: true});
    assert.deepEqual(
      service.get(ADDRESS).snapshot.transactions.map(tx => tx.txid),
      latest.map(tx => tx.txid),
    );
    assert.equal(service.get(ADDRESS).snapshot.hasMore, latest.length === 25);
  }
});

test('a default refresh still replaces paginated history for explicit send checks', async () => {
  const history = Array.from({length: 26}, (_, index) =>
    historyTransaction(index + 1),
  );
  const service = new BitcoinWalletService(
    api({
      async getTransactions(_address, cursor) {
        return cursor ? history.slice(25) : history.slice(0, 25);
      },
    }),
  );
  await service.refresh(ADDRESS);
  await service.loadMore(ADDRESS);
  await service.refresh(ADDRESS);
  assert.equal(service.get(ADDRESS).snapshot.transactions.length, 25);
  assert.equal(service.get(ADDRESS).snapshot.hasMore, true);
});

test('cancelled pagination results and errors cannot overwrite an automatic refresh', async () => {
  const history = Array.from({length: 50}, (_, index) =>
    historyTransaction(index + 1),
  );
  for (const failed of [false, true]) {
    const page = Promise.withResolvers();
    let latest = history.slice(0, 25);
    const service = new BitcoinWalletService(
      api({
        async getTransactions(_address, cursor) {
          return cursor ? page.promise : latest;
        },
      }),
    );
    await service.refresh(ADDRESS);
    const loadingMore = service.loadMore(ADDRESS);
    latest = [
      {...transaction('ff'.repeat(32)), status: {...STATUS, blockHeight: 1000}},
      ...history.slice(0, 24),
    ];
    await service.refresh(ADDRESS, {preserveHistory: true});
    if (failed) page.reject(new Error('Old page failed'));
    else page.resolve(history.slice(25));
    await loadingMore;
    const state = service.get(ADDRESS);
    assert.equal(state.status, 'ready');
    assert.equal(state.historyError, undefined);
    assert.equal(state.loadingMore, false);
    assert.equal(state.snapshot.transactions.length, 26);
    assert.equal(state.snapshot.transactions[0].txid, latest[0].txid);
  }
});

test('failed automatic refresh retains the paginated snapshot and exposes the error', async () => {
  const history = Array.from({length: 26}, (_, index) =>
    historyTransaction(index + 1),
  );
  let offline = false;
  const service = new BitcoinWalletService(
    api({
      async getTransactions(_address, cursor) {
        if (offline) throw new Error('Offline');
        return cursor ? history.slice(25) : history.slice(0, 25);
      },
    }),
  );
  await service.refresh(ADDRESS);
  await service.loadMore(ADDRESS);
  const snapshot = service.get(ADDRESS).snapshot;
  offline = true;
  await service.refresh(ADDRESS, {preserveHistory: true});
  const state = service.get(ADDRESS);
  assert.equal(state.status, 'error');
  assert.equal(state.error, 'Offline');
  assert.equal(state.snapshot, snapshot);
});

test('unknown broadcast is persisted before submission and reserves funds across restarts', async () => {
  let saved;
  const submission = {
    txid: 'ff'.repeat(32),
    hex: '01000000',
    inputOutpoints: [`${TXID}:0`],
  };
  const storage = {
    async set(key, value) {
      assert.equal(key, 'bitcoinSubmissions');
      saved = structuredClone(value);
    },
  };
  const service = new BitcoinWalletService(
    api({
      async broadcastTransaction() {
        assert.equal(saved[0].status, 'signed');
        throw new BitcoinBroadcastError(
          'Unknown response',
          'unknown',
          submission.txid,
        );
      },
    }),
    storage,
  );
  await service.refresh(ADDRESS);
  await assert.rejects(
    service.broadcast(ADDRESS, submission),
    /Unknown response/,
  );
  assert.equal(saved[0].status, 'unknown');
  assert.equal(service.get(ADDRESS).snapshot.spendableBalance, 0n);
  const restored = new BitcoinWalletService(api(), storage, saved);
  await restored.refresh(ADDRESS);
  assert.equal(restored.get(ADDRESS).snapshot.spendableBalance, 0n);
  assert.equal(restored.getSubmissions(ADDRESS)[0].hex, submission.hex);
});

test('failed persistence prevents any broadcast request', async () => {
  let broadcasts = 0;
  const service = new BitcoinWalletService(
    api({
      async broadcastTransaction() {
        broadcasts++;
      },
    }),
    {
      async set() {
        throw new Error('Storage full');
      },
    },
  );
  await assert.rejects(
    service.broadcast(ADDRESS, {
      txid: TXID,
      hex: '01000000',
      inputOutpoints: [],
    }),
    /Storage full/,
  );
  assert.equal(broadcasts, 0);
});

test('reviewed payment metadata survives storage and retries without requiring network history', async () => {
  let saved;
  const payment = {recipient: OTHER, amountSats: '18000', feeSats: '1000'};
  const transaction = {
    txid: 'ff'.repeat(32),
    hex: '01000000',
    inputOutpoints: [`${TXID}:0`],
    payment,
  };
  const storage = {
    async set(_key, value) {
      saved = structuredClone(value);
    },
  };
  const service = new BitcoinWalletService(
    api({
      async broadcastTransaction() {
        throw new Error('Offline');
      },
    }),
    storage,
  );
  await assert.rejects(service.broadcast(ADDRESS, transaction), /Offline/);
  assert.deepEqual(saved[0].payment, payment);
  const restored = new BitcoinWalletService(api(), storage, saved);
  const {payment: _payment, ...retry} = transaction;
  assert.deepEqual(restored.getSubmissions(ADDRESS)[0].payment, payment);
  await restored.broadcast(ADDRESS, retry);
  assert.deepEqual(saved[0].payment, payment);
});

test('a known rejection releases inputs but cannot release an earlier unknown submission', async () => {
  const submission = {
    address: ADDRESS,
    txid: 'ff'.repeat(32),
    hex: '01000000',
    inputOutpoints: [`${TXID}:0`],
    createdAt: 1,
    status: 'unknown',
  };
  const rejectedApi = api({
    async broadcastTransaction() {
      throw new BitcoinBroadcastError('Rejected', 'rejected', submission.txid);
    },
  });
  const fresh = new BitcoinWalletService(rejectedApi);
  await fresh.refresh(ADDRESS);
  await assert.rejects(fresh.broadcast(ADDRESS, submission));
  assert.equal(fresh.get(ADDRESS).snapshot.spendableBalance, 10000n);
  const retried = new BitcoinWalletService(rejectedApi, undefined, [
    submission,
  ]);
  await retried.refresh(ADDRESS);
  await assert.rejects(retried.broadcast(ADDRESS, submission));
  assert.equal(retried.get(ADDRESS).snapshot.spendableBalance, 0n);
});

test('parallel prepared payments cannot broadcast the same reserved input', async () => {
  const inFlight = Promise.withResolvers();
  const submitted = Promise.withResolvers();
  const service = new BitcoinWalletService(
    api({
      async broadcastTransaction() {
        submitted.resolve();
        return inFlight.promise;
      },
    }),
  );
  const first = {
    txid: '11'.repeat(32),
    hex: '01000000',
    inputOutpoints: [`${TXID}:0`],
  };
  const pending = service.broadcast(ADDRESS, first);
  await submitted.promise;
  await assert.rejects(
    service.broadcast(ADDRESS, {...first, txid: '22'.repeat(32)}),
    /already belong/,
  );
  inFlight.resolve(first.txid);
  await pending;
});

test('retrying a rejected payment reserves its inputs again before network returns', async () => {
  const inFlight = Promise.withResolvers();
  const submission = {
    address: ADDRESS,
    txid: '11'.repeat(32),
    hex: '01000000',
    inputOutpoints: [`${TXID}:0`],
    createdAt: 1,
    status: 'rejected',
  };
  const service = new BitcoinWalletService(
    api({
      async broadcastTransaction() {
        return inFlight.promise;
      },
    }),
    undefined,
    [submission],
  );
  await service.refresh(ADDRESS);
  assert.equal(service.get(ADDRESS).snapshot.spendableBalance, 10000n);
  const retry = service.broadcast(ADDRESS, submission);
  assert.equal(service.get(ADDRESS).snapshot.spendableBalance, 0n);
  inFlight.resolve(submission.txid);
  await retry;
});
