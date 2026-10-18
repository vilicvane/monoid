import assert from 'node:assert/strict';
import {createPrivateKey, createPublicKey, sign} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';

import {base58} from '@scure/base';

// eslint-disable-next-line @mufan/scoped-modules -- Verify the exact compiled transaction bytes.
import {parseSolanaTransaction} from '../.bld/app/@lib/solana-transaction.js';
// eslint-disable-next-line @mufan/scoped-modules -- Exercise production request authorization.
import {parseWalletConnectRequest} from '../.bld/app/@lib/wallet-connect-request.js';
// eslint-disable-next-line @mufan/scoped-modules, @mufan/import -- Avoid starting platform services.
import {WalletKitService} from '../.bld/app/@services/wallet-kit-service.js';

const CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const TOPIC = 'solana-send-session';
const METHOD = 'solana_signAndSendTransaction';
const STORAGE = 'walletKitSolanaTransactionSubmissions';

function signingKey(byte) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, byte),
    ]),
    type: 'pkcs8',
    format: 'der',
  });
  const publicKey = createPublicKey(privateKey)
    .export({type: 'spki', format: 'der'})
    .subarray(-32);

  return {privateKey, publicKey, address: base58.encode(publicKey)};
}

const payer = signingKey(1);
const signer = signingKey(2);

function transaction({amount = 1, presigned = true} = {}) {
  // The wallet signs the second slot; the first signature is the transaction ID.
  const message = Uint8Array.from([
    0x80,
    2,
    0,
    1,
    3,
    ...payer.publicKey,
    ...signer.publicKey,
    ...new Uint8Array(32),
    ...new Uint8Array(32).fill(4),
    1,
    2,
    2,
    0,
    1,
    12,
    2,
    0,
    0,
    0,
    amount,
    ...new Uint8Array(7),
    0,
  ]);
  const payerSignature = sign(null, message, payer.privateKey);
  const signerSignature = sign(null, message, signer.privateKey);
  const prefix = [2, ...(presigned ? payerSignature : new Uint8Array(64))];

  return {
    message,
    encoded: Buffer.from([
      ...prefix,
      ...new Uint8Array(64),
      ...message,
    ]).toString('base64'),
    signedTransaction: Buffer.from([
      ...prefix,
      ...signerSignature,
      ...message,
    ]).toString('base64'),
    signature: base58.encode(payerSignature),
    signed: {
      address: signer.address,
      signature: base58.encode(signerSignature),
    },
  };
}

function status(accepted = false) {
  return {
    context: {slot: 100},
    value: [
      accepted
        ? {
            slot: 99,
            err: null,
            confirmations: 1,
            confirmationStatus: 'confirmed',
          }
        : null,
    ],
  };
}

function setup(context, options) {
  const fixture = transaction(options);
  const incoming = {
    id: 1,
    topic: TOPIC,
    params: {
      chainId: CHAIN,
      request: {
        method: METHOD,
        params: {transaction: fixture.encoded, pubkey: signer.address},
        expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
      },
    },
    verifyContext: {
      verified: {origin: 'https://example.com', validation: 'VALID'},
    },
  };
  const approved = {
    topic: TOPIC,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    namespaces: {
      solana: {
        chains: [CHAIN],
        accounts: [`${CHAIN}:${signer.address}`],
        methods: [METHOD],
        events: [],
      },
    },
  };
  const sessions = {[TOPIC]: approved};
  const requests = [incoming];
  const values = new Map();
  const writes = [];
  const storage = {
    get: context.mock.fn(async key => structuredClone(values.get(key))),
    set: context.mock.fn(async (key, value) => {
      const snapshot = structuredClone(value);
      writes.push({key, value: snapshot});
      values.set(key, snapshot);
    }),
  };
  const kit = Object.assign(new EventEmitter(), {
    core: {pairing: {events: new EventEmitter()}},
    engine: {signClient: {events: new EventEmitter()}},
    getActiveSessions: context.mock.fn(() => ({...sessions})),
    getPendingSessionRequests: context.mock.fn(() => [...requests]),
    respondSessionRequest: context.mock.fn(async ({response}) => {
      const index = requests.findIndex(item => item.id === response.id);
      if (index !== -1) requests.splice(index, 1);
    }),
  });
  const addressBook = {rememberSigned: context.mock.fn(async () => {})};
  const callHistory = {rememberSigned: context.mock.fn(async () => {})};
  const history = {rememberSubmitted: context.mock.fn(async () => {})};
  const service = new WalletKitService(
    kit,
    storage,
    addressBook,
    callHistory,
    history,
  );
  const reviewed = parseWalletConnectRequest(incoming, approved);
  const rpc = context.mock.fn(async method => {
    if (method === 'getSignatureStatuses') return status();
    if (method === 'sendTransaction') return fixture.signature;
    throw new Error(`Unexpected RPC ${method}`);
  });

  return {
    fixture,
    incoming,
    approved,
    requests,
    sessions,
    values,
    writes,
    storage,
    kit,
    service,
    reviewed,
    rpc,
    approve: () =>
      service.approveSolanaTransactionRequest(
        1,
        TOPIC,
        reviewed,
        [fixture.signed],
        rpc,
      ),
    reload: () =>
      WalletKitService.create(kit, storage, addressBook, callHistory, history),
  };
}

function broadcasts(state) {
  return state.rpc.mock.calls.filter(
    call => call.arguments[0] === 'sendTransaction',
  );
}

test('saves exact original and signed bytes before RPC, returning the fee payer signature', async context => {
  const state = setup(context);
  const {fixture, rpc, values, kit} = state;
  rpc.mock.mockImplementation(async (method, params) => {
    const saved = values.get(STORAGE)['1'];
    assert.equal(saved.transaction, fixture.encoded);
    assert.equal(saved.signedTransaction, fixture.signedTransaction);
    assert.equal(saved.address, signer.address);
    assert.equal(saved.broadcast, false);
    assert.deepEqual(saved.sendOptions, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    if (method === 'getSignatureStatuses') {
      assert.deepEqual(params, [
        [fixture.signature],
        {searchTransactionHistory: true},
      ]);
      return status();
    }
    assert.equal(method, 'sendTransaction');
    assert.equal(params[0], saved.signedTransaction);
    assert.deepEqual(
      parseSolanaTransaction(params[0]).messageBytes,
      fixture.message,
    );
    assert.equal(params[1].encoding, 'base64');
    return fixture.signature;
  });

  assert.equal(await state.approve(), true);
  assert.equal(broadcasts(state).length, 1);
  assert.notEqual(fixture.signature, fixture.signed.signature);
  assert.deepEqual(
    kit.respondSessionRequest.mock.calls[0].arguments[0].response.result,
    {signature: fixture.signature},
  );
  assert.ok(
    state.writes.some(
      write => write.key === STORAGE && write.value['1']?.broadcast,
    ),
  );
});

test('duplicate approval and rejection share one broadcast and success reply', async context => {
  const state = setup(context);
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  state.rpc.mock.mockImplementation(async method => {
    if (method === 'getSignatureStatuses') return status();
    started.resolve();
    await finish.promise;
    return state.fixture.signature;
  });
  const first = state.approve();
  const second = state.approve();
  assert.equal(first, second);
  await started.promise;
  const rejected = state.service.rejectRequest(1);
  assert.equal(state.kit.respondSessionRequest.mock.callCount(), 0);
  finish.resolve();
  await Promise.all([first, second, rejected]);
  assert.equal(broadcasts(state).length, 1);
  assert.equal(state.kit.respondSessionRequest.mock.callCount(), 1);
  assert.equal(
    state.kit.respondSessionRequest.mock.calls[0].arguments[0].response.error,
    undefined,
  );
});

test('Relay retry restores persisted bytes after reload and does not broadcast again', async context => {
  const state = setup(context);
  state.kit.respondSessionRequest.mock.mockImplementationOnce(async () => {
    throw new Error('Relay offline');
  });
  await assert.rejects(state.approve(), /Relay offline/);
  assert.equal(state.service.getSolanaTransactionSubmission(1).broadcast, true);
  const saved = structuredClone(state.values.get(STORAGE)['1']);
  const restored = await state.reload();
  assert.deepEqual(restored.getSolanaTransactionSubmission(1), saved);
  const calls = state.rpc.mock.callCount();
  assert.equal(await restored.resumeSolanaTransactionRequest(1, TOPIC), true);
  assert.equal(state.rpc.mock.callCount(), calls);
  assert.equal(state.kit.respondSessionRequest.mock.callCount(), 2);
  assert.deepEqual(
    state.kit.respondSessionRequest.mock.calls[1].arguments[0].response.result,
    {signature: state.fixture.signature},
  );
});

test('lost RPC response recovers observed acceptance without a second broadcast', async context => {
  const state = setup(context);
  let accepted = false;
  state.rpc.mock.mockImplementation(async method => {
    if (method === 'getSignatureStatuses') return status(accepted);
    accepted = true;
    throw new Error('Connection closed after sending');
  });
  assert.equal(await state.approve(), true);
  assert.equal(broadcasts(state).length, 1);
  assert.equal(state.kit.respondSessionRequest.mock.callCount(), 1);
});

test('RPC rejection preserves the signed attempt, blocks Reject, and retries exact bytes after reload', async context => {
  const state = setup(context);
  state.rpc.mock.mockImplementation(async method => {
    if (method === 'getSignatureStatuses') return status();
    throw new Error('Insufficient funds for fee');
  });
  await assert.rejects(state.approve(), /Insufficient funds for fee/);
  const saved = structuredClone(state.values.get(STORAGE)['1']);
  assert.equal(saved.broadcast, false);
  await state.service.rejectRequest(1);
  assert.equal(state.kit.respondSessionRequest.mock.callCount(), 0);

  const restored = await state.reload();
  state.rpc.mock.mockImplementation(async method =>
    method === 'getSignatureStatuses' ? status() : state.fixture.signature,
  );
  assert.equal(
    await restored.resumeSolanaTransactionRequest(1, TOPIC, state.rpc),
    true,
  );
  assert.deepEqual(
    broadcasts(state).map(call => call.arguments[1][0]),
    [saved.signedTransaction, saved.signedTransaction],
  );
});

test('storage failure prevents any RPC call and publication', async context => {
  const state = setup(context);
  state.storage.set.mock.mockImplementation(async key => {
    if (key === STORAGE) throw new Error('Storage unavailable');
  });
  await assert.rejects(state.approve(), /Storage unavailable/);
  assert.equal(state.rpc.mock.callCount(), 0);
  assert.equal(state.kit.respondSessionRequest.mock.callCount(), 0);
});

test('missing co-signature prevents persisting or broadcasting an incomplete transaction', async context => {
  const state = setup(context, {presigned: false});
  await assert.rejects(state.approve(), /missing a required signature/);
  assert.equal(state.service.getSolanaTransactionSubmission(1), undefined);
  assert.equal(state.values.has(STORAGE), false);
  assert.equal(state.rpc.mock.callCount(), 0);
  assert.equal(state.kit.respondSessionRequest.mock.callCount(), 0);
});

for (const awaiting of ['storage', 'status', 'accepted status']) {
  test(`request changes while awaiting ${awaiting} cannot send or publish`, async context => {
    for (const change of ['options', 'chain', 'bytes', 'authorization']) {
      const state = setup(context);
      const started = Promise.withResolvers();
      const finish = Promise.withResolvers();
      if (awaiting === 'storage') {
        state.storage.set.mock.mockImplementation(async (key, value) => {
          if (key === STORAGE) {
            started.resolve();
            await finish.promise;
          }
          state.values.set(key, structuredClone(value));
        });
      } else {
        state.rpc.mock.mockImplementation(async method => {
          if (method === 'sendTransaction') return state.fixture.signature;
          started.resolve();
          await finish.promise;
          return status(awaiting === 'accepted status');
        });
      }
      const outcome = Promise.allSettled([state.approve()]);
      await started.promise;
      if (change === 'options')
        state.incoming.params.request.params.sendOptions = {
          skipPreflight: true,
        };
      if (change === 'chain')
        state.incoming.params.chainId =
          'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
      if (change === 'bytes')
        state.incoming.params.request.params.transaction = transaction({
          amount: 2,
        }).encoded;
      if (change === 'authorization')
        state.approved.namespaces.solana.accounts = [];
      finish.resolve();
      const [result] = await outcome;
      assert.equal(result.status, 'rejected', `${awaiting}: ${change}`);
      assert.equal(broadcasts(state).length, 0, `${awaiting}: ${change}`);
      assert.equal(
        state.kit.respondSessionRequest.mock.callCount(),
        0,
        `${awaiting}: ${change}`,
      );
    }
  });
}
