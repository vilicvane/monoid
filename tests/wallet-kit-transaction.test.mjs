import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';

import {Interface, Transaction, Wallet, keccak256} from 'ethers';

// eslint-disable-next-line @mufan/scoped-modules, @mufan/import -- Exercise the service without starting platform services.
import {WalletKitService} from '../.bld/app/@services/wallet-kit-service.js';

const {parseWalletConnectTransactionRequest} = await import(
  '../.bld/app/@lib/wallet-connect-request.js'
);
const {assertWalletConnectTransaction, getEvmTransactionAddresses} =
  await import('../.bld/app/@lib/wallet-connect-transaction.js');
const {decodeEvmCalldata} = await import('../.bld/app/@lib/evm-calldata.js');

// Public fixture keys only; these accounts must never hold funds.
const wallet = new Wallet(`0x${'1'.padStart(64, '0')}`);
const otherWallet = new Wallet(`0x${'2'.padStart(64, '0')}`);
const recipient = '0x3535353535353535353535353535353535353535';
const topic = 'transaction-session';

function setup(context, transaction = {}, chainId = 1n) {
  const request = {
    id: 1,
    topic,
    params: {
      chainId: `eip155:${chainId}`,
      request: {
        method: 'eth_sendTransaction',
        params: [
          {from: wallet.address, to: recipient, value: '0x5', ...transaction},
        ],
        expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
      },
    },
    verifyContext: {
      verified: {origin: 'https://example.com', validation: 'VALID'},
    },
  };
  const sessions = {
    [topic]: {
      topic,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      namespaces: {
        eip155: {
          accounts: [`eip155:${chainId}:${wallet.address}`],
          methods: ['eth_sendTransaction'],
          chains: [`eip155:${chainId}`],
          events: [],
        },
      },
    },
  };
  const requests = [request];
  const kit = Object.assign(new EventEmitter(), {
    core: {pairing: {events: new EventEmitter()}},
    engine: {signClient: {events: new EventEmitter()}},
    getActiveSessions: context.mock.fn(() => ({...sessions})),
    getPendingSessionRequests: context.mock.fn(() => [...requests]),
    respondSessionRequest: context.mock.fn(async ({response}) => {
      requests.splice(
        requests.findIndex(request => request.id === response.id),
        1,
      );
    }),
  });
  const records = {
    [topic]: {
      connectedAt: 1,
      lastActivityAt: 1,
      verified: request.verifyContext.verified,
    },
  };
  const values = new Map([['walletKitSessionRecords', records]]);
  const storage = {
    get: context.mock.fn(async key => structuredClone(values.get(key))),
    set: context.mock.fn(async (key, value) => {
      values.set(key, structuredClone(value));
    }),
  };
  const addressBook = {rememberSigned: context.mock.fn(async () => {})};
  const callHistory = {rememberSigned: context.mock.fn(async () => {})};
  const transactionHistory = {
    rememberSubmitted: context.mock.fn(async () => {}),
  };
  const accepted = new Map();
  const provider = {
    getNetwork: context.mock.fn(async () => ({chainId})),
    getTransaction: context.mock.fn(async hash => accepted.get(hash) ?? null),
    broadcastTransaction: context.mock.fn(async raw => {
      const hash = keccak256(raw);
      accepted.set(hash, {hash});
      return {hash};
    }),
  };
  const payload = parseWalletConnectTransactionRequest(
    request,
    sessions[topic],
  );
  const prepared = Transaction.from({
    ...payload.transaction,
    type: 2,
    nonce: 7,
    gasLimit: 21000n,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
  });
  const unsigned = prepared.unsignedSerialized;
  const signature = wallet.signingKey.sign(prepared.unsignedHash).serialized;
  prepared.signature = signature;
  const raw = prepared.serialized;
  const hash = prepared.hash;
  const service = new WalletKitService(
    kit,
    storage,
    addressBook,
    callHistory,
    transactionHistory,
    {rememberSubmitted: context.mock.fn(async () => {})},
    records,
  );
  return {
    service,
    kit,
    storage,
    values,
    addressBook,
    callHistory,
    transactionHistory,
    requests,
    request,
    sessions,
    provider,
    accepted,
    unsigned,
    signature,
    raw,
    hash,
  };
}

function approve({service, unsigned, signature, provider}, decodedData) {
  return service.approveTransactionRequest(
    1,
    topic,
    unsigned,
    signature,
    provider,
    decodedData,
  );
}

test('persists exact signed bytes before broadcasting, responds with the hash and clears completed recovery data', async context => {
  const state = setup(context);
  const {service, provider, values, raw, hash, kit, addressBook} = state;
  provider.broadcastTransaction.mock.mockImplementationOnce(async sent => {
    assert.equal(sent, raw);
    assert.deepEqual(values.get('walletKitTransactionSubmissions'), {
      1: {topic, signedTransaction: raw, broadcast: false},
    });
    return {hash};
  });
  state.transactionHistory.rememberSubmitted.mock.mockImplementationOnce(
    async signedTransaction => {
      assert.equal(signedTransaction, raw);
      assert.equal(kit.respondSessionRequest.mock.callCount(), 0);
      assert.equal(
        values.get('walletKitTransactionSubmissions')[1].broadcast,
        true,
      );
    },
  );

  assert.equal(await approve(state), true);

  assert.deepEqual(kit.respondSessionRequest.mock.calls[0].arguments, [
    {topic, response: {id: 1, jsonrpc: '2.0', result: hash}},
  ]);
  assert.deepEqual(addressBook.rememberSigned.mock.calls[0].arguments, [
    'evm',
    [recipient],
  ]);
  assert.equal(service.getTransactionSubmission(1), undefined);
  assert.deepEqual(values.get('walletKitTransactionSubmissions'), {});
  assert.equal(provider.broadcastTransaction.mock.callCount(), 1);
  assert.equal(state.callHistory.rememberSigned.mock.callCount(), 0);
  assert.equal(state.transactionHistory.rememberSubmitted.mock.callCount(), 1);
});

test('remembers reviewed calldata addresses and final implementation calls only after a matching transaction is signed', async context => {
  const iface = new Interface(['function transfer(address to,uint256 amount)']);
  const data = iface.encodeFunctionData('transfer', [
    otherWallet.address,
    123n,
  ]);
  const decoded = await decodeEvmCalldata(data, recipient, {
    async getContract(address) {
      return address.toLowerCase() === recipient.toLowerCase()
        ? {iface, implementations: [otherWallet.address], isProxy: true}
        : {iface, implementations: [], isProxy: false};
    },
    async getSignatures() {
      return [];
    },
  });
  const state = setup(context, {data});
  assert.equal(state.addressBook.rememberSigned.mock.callCount(), 0);
  assert.equal(state.callHistory.rememberSigned.mock.callCount(), 0);
  assert.equal(
    await state.service.approveTransactionRequest(
      1,
      topic,
      state.unsigned,
      state.signature,
      state.provider,
      decoded,
    ),
    true,
  );
  assert.deepEqual(state.addressBook.rememberSigned.mock.calls[0].arguments, [
    'evm',
    [recipient, otherWallet.address.toLowerCase()],
  ]);
  assert.deepEqual(state.callHistory.rememberSigned.mock.calls[0].arguments, [
    'eip155:1',
    [
      {
        contractAddress: otherWallet.address,
        signature: 'transfer(address,uint256)',
      },
    ],
  ]);

  for (const change of [{data: '0x'}, {target: otherWallet.address}]) {
    const state = setup(context, {data});
    await assert.rejects(
      state.service.approveTransactionRequest(
        1,
        topic,
        state.unsigned,
        state.signature,
        state.provider,
        {...decoded, ...change},
      ),
      /decoded data no longer matches/,
    );
    assert.equal(state.addressBook.rememberSigned.mock.callCount(), 0);
    assert.equal(state.callHistory.rememberSigned.mock.callCount(), 0);
    assert.equal(state.provider.broadcastTransaction.mock.callCount(), 0);
    assert.equal(state.service.getTransactionSubmission(1), undefined);
  }
});

test('receiving, rejecting and invalid transaction signatures do not create call history', async context => {
  const iface = new Interface([
    'function approve(address spender,uint256 amount)',
  ]);
  const data = iface.encodeFunctionData('approve', [otherWallet.address, 1n]);
  const decoded = await decodeEvmCalldata(data, recipient, {
    async getContract() {
      return {iface, implementations: [], isProxy: false};
    },
    async getSignatures() {
      return [];
    },
  });
  const state = setup(context, {data});
  const wrongSignature = otherWallet.signingKey.sign(
    keccak256(state.unsigned),
  ).serialized;

  assert.equal(state.callHistory.rememberSigned.mock.callCount(), 0);
  await assert.rejects(
    approve({...state, signature: wrongSignature}, decoded),
    /signature does not match/,
  );
  assert.equal(state.callHistory.rememberSigned.mock.callCount(), 0);
  await state.service.rejectRequest(1);
  assert.equal(state.callHistory.rememberSigned.mock.callCount(), 0);
  assert.equal(state.provider.broadcastTransaction.mock.callCount(), 0);
});

test('records the signed chain and function before broadcasting even when broadcast fails, and preserves history on retry', async context => {
  const iface = new Interface([
    'function approve(address spender,uint256 amount)',
  ]);
  const data = iface.encodeFunctionData('approve', [otherWallet.address, 1n]);
  const decoded = await decodeEvmCalldata(data, recipient, {
    async getContract() {
      return {iface, implementations: [], isProxy: false};
    },
    async getSignatures() {
      return [];
    },
  });
  const state = setup(context, {data}, 137n);
  const failure = new Error('Offline');
  const expected = [
    'eip155:137',
    [{contractAddress: recipient, signature: 'approve(address,uint256)'}],
  ];
  state.provider.broadcastTransaction.mock.mockImplementationOnce(async () => {
    assert.deepEqual(
      state.callHistory.rememberSigned.mock.calls[0].arguments,
      expected,
    );
    throw failure;
  });

  await assert.rejects(approve(state, decoded), failure);
  assert.equal(state.callHistory.rememberSigned.mock.callCount(), 1);
  assert.equal(await approve(state, decoded), true);
  assert.deepEqual(
    state.callHistory.rememberSigned.mock.calls[1].arguments,
    expected,
  );
});

test('broadcasts the exact reviewed gas edits for legacy, access-list and EIP-1559 transactions', async context => {
  for (const type of [0, 1, 2]) {
    const state = setup(context);
    Object.assign(state.request.params.request.params[0], {
      type,
      gas: 21000,
      ...(type === 2
        ? {maxFeePerGas: 10, maxPriorityFeePerGas: 1}
        : {gasPrice: 10}),
    });
    const edited = Transaction.from({
      chainId: 1n,
      to: recipient,
      value: 5n,
      nonce: 7,
      type,
      gasLimit: 30000n,
      ...(type === 2
        ? {maxFeePerGas: 20n, maxPriorityFeePerGas: 2n}
        : {gasPrice: 20n}),
    });
    const unsigned = edited.unsignedSerialized;
    const signature = wallet.signingKey.sign(edited.unsignedHash).serialized;
    edited.signature = signature;

    assert.equal(await approve({...state, unsigned, signature}), true);
    assert.deepEqual(
      state.provider.broadcastTransaction.mock.calls[0].arguments,
      [edited.serialized],
    );
    assert.equal(
      state.kit.respondSessionRequest.mock.calls[0].arguments[0].response
        .result,
      edited.hash,
    );
  }
});

test('rejects an old signature after gas settings change', async context => {
  const state = setup(context);
  const edited = Transaction.from(state.unsigned);
  edited.maxFeePerGas = 20n;

  await assert.rejects(
    approve({...state, unsigned: edited.unsignedSerialized}),
    /signature does not match/,
  );
  assert.equal(state.provider.broadcastTransaction.mock.callCount(), 0);
  assert.equal(state.service.getTransactionSubmission(1), undefined);
});

test('rejects invalid gas settings before saving or broadcasting', async context => {
  const state = setup(context);
  const edited = Transaction.from(state.unsigned);
  edited.gasLimit = 0n;
  const signature = wallet.signingKey.sign(edited.unsignedHash).serialized;

  await assert.rejects(
    approve({...state, unsigned: edited.unsignedSerialized, signature}),
    /Gas limit must be a positive integer/,
  );
  assert.equal(state.provider.broadcastTransaction.mock.callCount(), 0);
  assert.equal(state.service.getTransactionSubmission(1), undefined);
});

test('validates the requested action and authorization again before sending', async context => {
  for (const fields of [
    {to: otherWallet.address},
    {value: '0x6'},
    {data: '0x01'},
    {nonce: 8},
    {type: 1},
    {accessList: [{address: recipient, storageKeys: [`0x${'00'.repeat(32)}`]}]},
  ]) {
    const state = setup(context);
    Object.assign(state.request.params.request.params[0], fields);
    await assert.rejects(approve(state), /no longer matches/);
    assert.equal(state.provider.broadcastTransaction.mock.callCount(), 0);
    assert.equal(state.kit.respondSessionRequest.mock.callCount(), 0);
    assert.equal(state.service.getTransactionSubmission(1), undefined);
  }
  for (const field of ['methods', 'accounts', 'chains']) {
    const state = setup(context);
    state.sessions[topic].namespaces.eip155[field] = [];
    await assert.rejects(approve(state), {code: 4100});
    assert.equal(state.provider.broadcastTransaction.mock.callCount(), 0);
  }
});

test('rejects wrong-account signatures, already signed review bytes and changed transaction networks', async context => {
  const state = setup(context);
  const {service, unsigned, provider, raw, signature} = state;
  const otherSignature = otherWallet.signingKey.sign(
    keccak256(unsigned),
  ).serialized;
  await assert.rejects(
    service.approveTransactionRequest(
      1,
      topic,
      unsigned,
      otherSignature,
      provider,
    ),
    /signature does not match/,
  );
  await assert.rejects(
    service.approveTransactionRequest(1, topic, raw, signature, provider),
    /Invalid unsigned/,
  );
  const changed = Transaction.from(unsigned);
  changed.chainId = 137;
  await assert.rejects(
    service.approveTransactionRequest(
      1,
      topic,
      changed.unsignedSerialized,
      signature,
      provider,
    ),
    /no longer matches/,
  );
  assert.equal(provider.broadcastTransaction.mock.callCount(), 0);
});

test('binds approval to the session that was reviewed even if another session reuses the request ID', async context => {
  const state = setup(context);
  const replacementTopic = 'replacement-session';
  state.sessions[replacementTopic] = {
    ...state.sessions[topic],
    topic: replacementTopic,
  };
  state.requests[0] = {...state.request, topic: replacementTopic};

  await assert.rejects(approve(state), {code: 4100});

  assert.equal(state.provider.broadcastTransaction.mock.callCount(), 0);
  assert.equal(state.kit.respondSessionRequest.mock.callCount(), 0);
  assert.equal(state.service.getTransactionSubmission(1), undefined);
});

test('an initial persistence failure prevents every network send and leaves a recoverable exact transaction', async context => {
  const state = setup(context);
  const {storage, provider, service, raw} = state;
  const failure = new Error('Storage unavailable');
  storage.set.mock.mockImplementation(async key => {
    if (key === 'walletKitTransactionSubmissions') throw failure;
  });

  await assert.rejects(approve(state), failure);

  assert.equal(provider.getNetwork.mock.callCount(), 0);
  assert.equal(provider.broadcastTransaction.mock.callCount(), 0);
  assert.equal(state.transactionHistory.rememberSubmitted.mock.callCount(), 0);
  assert.deepEqual(service.getTransactionSubmission(1), {
    topic,
    signedTransaction: raw,
    broadcast: false,
  });
});

test('a failed website response retries the same hash without RPC or a second broadcast, including after reload', async context => {
  const state = setup(context);
  const {kit, storage, addressBook, provider, raw, unsigned, signature, hash} =
    state;
  const failure = new Error('Relay unavailable');
  kit.respondSessionRequest.mock.mockImplementationOnce(async () => {
    throw failure;
  });
  await assert.rejects(approve(state), failure);
  assert.deepEqual(
    state.transactionHistory.rememberSubmitted.mock.calls.map(
      call => call.arguments,
    ),
    [[raw]],
  );

  const reloaded = await WalletKitService.create(
    kit,
    storage,
    addressBook,
    state.callHistory,
    state.transactionHistory,
    {rememberSubmitted: context.mock.fn(async () => {})},
  );
  assert.deepEqual(reloaded.getTransactionSubmission(1), {
    topic,
    signedTransaction: raw,
    broadcast: true,
  });
  assert.equal(
    await reloaded.approveTransactionRequest(1, topic, unsigned, signature),
    true,
  );
  assert.equal(provider.broadcastTransaction.mock.callCount(), 1);
  assert.deepEqual(
    state.transactionHistory.rememberSubmitted.mock.calls.map(
      call => call.arguments,
    ),
    [[raw], [raw]],
  );
  assert.equal(
    kit.respondSessionRequest.mock.calls[1].arguments[0].response.result,
    hash,
  );
});

test('a failed history write preserves the accepted submission and retries without RPC after reload', async context => {
  const state = setup(context);
  const {
    kit,
    provider,
    storage,
    addressBook,
    callHistory,
    transactionHistory,
    raw,
  } = state;
  const failure = new Error('History storage unavailable');
  transactionHistory.rememberSubmitted.mock.mockImplementationOnce(async () => {
    throw failure;
  });

  await assert.rejects(approve(state), failure);

  assert.equal(provider.broadcastTransaction.mock.callCount(), 1);
  assert.equal(kit.respondSessionRequest.mock.callCount(), 0);
  assert.deepEqual(state.values.get('walletKitTransactionSubmissions'), {
    1: {topic, signedTransaction: raw, broadcast: true},
  });

  const reloaded = await WalletKitService.create(
    kit,
    storage,
    addressBook,
    callHistory,
    transactionHistory,
    {rememberSubmitted: context.mock.fn(async () => {})},
  );
  assert.equal(
    await reloaded.approveTransactionRequest(
      1,
      topic,
      state.unsigned,
      state.signature,
    ),
    true,
  );
  assert.equal(provider.broadcastTransaction.mock.callCount(), 1);
  assert.equal(provider.getNetwork.mock.callCount(), 1);
  assert.deepEqual(
    transactionHistory.rememberSubmitted.mock.calls.map(call => call.arguments),
    [[raw], [raw]],
  );
  assert.deepEqual(state.values.get('walletKitTransactionSubmissions'), {});
});

test('reload does not automatically broadcast and uncertain retries resend only the identical bytes', async context => {
  const state = setup(context);
  const {kit, provider, storage, addressBook, unsigned, signature, raw} = state;
  const failure = new Error('Connection lost before acknowledgement');
  provider.broadcastTransaction.mock.mockImplementationOnce(async () => {
    throw failure;
  });
  await assert.rejects(approve(state), failure);
  assert.equal(state.transactionHistory.rememberSubmitted.mock.callCount(), 0);

  const reloaded = await WalletKitService.create(
    kit,
    storage,
    addressBook,
    state.callHistory,
    state.transactionHistory,
    {rememberSubmitted: context.mock.fn(async () => {})},
  );
  assert.equal(provider.broadcastTransaction.mock.callCount(), 1);
  assert.equal(reloaded.getTransactionSubmission(1).broadcast, false);
  assert.equal(
    await reloaded.approveTransactionRequest(
      1,
      topic,
      unsigned,
      signature,
      provider,
    ),
    true,
  );
  assert.deepEqual(
    provider.broadcastTransaction.mock.calls.map(call => call.arguments[0]),
    [raw, raw],
  );
});

test('a broadcast with a lost response is recognized by its exact hash without a second send', async context => {
  const state = setup(context);
  const {provider, accepted, hash} = state;
  provider.broadcastTransaction.mock.mockImplementationOnce(async () => {
    accepted.set(hash, {hash});
    throw new Error('Connection lost after acceptance');
  });

  assert.equal(await approve(state), true);
  assert.equal(provider.broadcastTransaction.mock.callCount(), 1);
  assert.equal(provider.getTransaction.mock.callCount(), 2);
  assert.deepEqual(
    state.transactionHistory.rememberSubmitted.mock.calls[0].arguments,
    [state.raw],
  );
});

test('a recovered pending submission already known by its hash only sends the website response', async context => {
  const state = setup(context);
  const {provider, accepted, hash} = state;
  provider.broadcastTransaction.mock.mockImplementationOnce(async () => {
    throw new Error('Offline');
  });
  await assert.rejects(approve(state), /Offline/);
  assert.equal(state.transactionHistory.rememberSubmitted.mock.callCount(), 0);
  accepted.set(hash, {hash});

  assert.equal(await approve(state), true);
  assert.equal(provider.broadcastTransaction.mock.callCount(), 1);
  assert.deepEqual(
    state.transactionHistory.rememberSubmitted.mock.calls[0].arguments,
    [state.raw],
  );
});

test('a retry cannot substitute new nonce or gas settings for the persisted transaction', async context => {
  const state = setup(context);
  const {service, provider, unsigned} = state;
  provider.broadcastTransaction.mock.mockImplementationOnce(async () => {
    throw new Error('Offline');
  });
  await assert.rejects(approve(state), /Offline/);
  for (const edits of [
    {nonce: 8},
    {gasLimit: 30000n},
    {maxFeePerGas: 20n},
    {maxPriorityFeePerGas: 2n},
  ]) {
    const changed = Object.assign(Transaction.from(unsigned), edits);
    const signature = wallet.signingKey.sign(changed.unsignedHash).serialized;

    await assert.rejects(
      service.approveTransactionRequest(
        1,
        topic,
        changed.unsignedSerialized,
        signature,
        provider,
      ),
      /already submitted/,
    );
  }
  assert.equal(provider.broadcastTransaction.mock.callCount(), 1);
});

test('approval, duplicate clicks and leaving share the entire broadcast and reply lock', async context => {
  const state = setup(context);
  const {service, provider, kit, hash} = state;
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  provider.broadcastTransaction.mock.mockImplementationOnce(async () => {
    started.resolve();
    await finish.promise;
    return {hash};
  });
  const first = approve(state);
  const second = approve(state);
  assert.equal(first, second);
  await started.promise;
  const leaving = service.rejectRequest(1);
  assert.equal(service.isRespondingToRequest(1), true);
  assert.equal(kit.respondSessionRequest.mock.callCount(), 0);
  finish.resolve();

  await Promise.all([first, second, leaving]);
  assert.equal(provider.broadcastTransaction.mock.callCount(), 1);
  assert.equal(kit.respondSessionRequest.mock.callCount(), 1);
  assert.equal(
    kit.respondSessionRequest.mock.calls[0].arguments[0].response.error,
    undefined,
  );
});

test('a saved ambiguous submission cannot be rejected to the website after the response lock ends', async context => {
  const state = setup(context);
  state.provider.broadcastTransaction.mock.mockImplementationOnce(async () => {
    throw new Error('Offline');
  });
  await assert.rejects(approve(state), /Offline/);
  await state.service.rejectRequest(1);

  assert.equal(state.kit.respondSessionRequest.mock.callCount(), 0);
});

test('rechecks current request, expiry and authorization after awaiting the transaction lookup', async context => {
  for (const change of ['expired', 'disconnected', 'account', 'replaced']) {
    const state = setup(context);
    const {provider, request, requests, sessions, kit} = state;
    const started = Promise.withResolvers();
    const finish = Promise.withResolvers();
    provider.getTransaction.mock.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      return null;
    });
    const result = approve(state);
    const settled = Promise.allSettled([result]);
    await started.promise;
    if (change === 'expired') request.params.request.expiryTimestamp = 1;
    else if (change === 'disconnected') delete sessions[topic];
    else if (change === 'account')
      sessions[topic].namespaces.eip155.accounts = [
        `eip155:1:${otherWallet.address}`,
      ];
    else {
      requests[0] = structuredClone(request);
      requests[0].params.request.params[0].value = '0x6';
    }
    finish.resolve();
    const [outcome] = await settled;

    if (change === 'expired' || change === 'disconnected') {
      assert.deepEqual(outcome, {status: 'fulfilled', value: false});
    } else {
      assert.equal(outcome.status, 'rejected');
      if (change === 'account') assert.equal(outcome.reason.code, 4100);
      else assert.match(outcome.reason.message, /no longer matches/);
    }
    assert.equal(provider.broadcastTransaction.mock.callCount(), 0);
    assert.equal(kit.respondSessionRequest.mock.callCount(), 0);
  }
});

test('a different RPC network or unrelated lookup hash cannot confirm or broadcast this transaction', async context => {
  for (const change of ['network', 'hash']) {
    const state = setup(context);
    if (change === 'network')
      state.provider.getNetwork.mock.mockImplementation(async () => ({
        chainId: 137n,
      }));
    else
      state.provider.getTransaction.mock.mockImplementation(async () => ({
        hash: `0x${'00'.repeat(32)}`,
      }));

    await assert.rejects(
      approve(state),
      change === 'network' ? /different network/ : /different transaction hash/,
    );
    assert.equal(state.provider.broadcastTransaction.mock.callCount(), 0);
    assert.equal(state.kit.respondSessionRequest.mock.callCount(), 0);
    assert.equal(
      state.transactionHistory.rememberSubmitted.mock.callCount(),
      0,
    );
  }
});

test('a wrong hash after a broadcast error is not accepted as a successful send', async context => {
  const state = setup(context);
  const failure = new Error('Broadcast failed');
  state.provider.broadcastTransaction.mock.mockImplementationOnce(async () => {
    throw failure;
  });
  state.provider.getTransaction.mock.mockImplementationOnce(
    async () => ({hash: `0x${'00'.repeat(32)}`}),
    1,
  );

  await assert.rejects(approve(state), failure);
  assert.equal(state.kit.respondSessionRequest.mock.callCount(), 0);
  assert.equal(state.service.getTransactionSubmission(1).broadcast, false);
  assert.equal(state.transactionHistory.rememberSubmitted.mock.callCount(), 0);
});

test('restore prunes submissions whose request is no longer pending without broadcasting', async context => {
  const state = setup(context);
  const {provider, requests, kit, storage, addressBook, values} = state;
  provider.broadcastTransaction.mock.mockImplementationOnce(async () => {
    throw new Error('Offline');
  });
  await assert.rejects(approve(state), /Offline/);
  requests.length = 0;

  const reloaded = await WalletKitService.create(
    kit,
    storage,
    addressBook,
    state.callHistory,
    state.transactionHistory,
    {rememberSubmitted: context.mock.fn(async () => {})},
  );
  assert.equal(reloaded.getTransactionSubmission(1), undefined);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(values.get('walletKitTransactionSubmissions'), {});
  assert.equal(provider.broadcastTransaction.mock.callCount(), 1);
});

test('shared transaction review validation and address extraction do not infer addresses from calldata', context => {
  const state = setup(context);
  const payload = parseWalletConnectTransactionRequest(
    state.request,
    state.sessions[topic],
  );
  assert.doesNotThrow(() =>
    assertWalletConnectTransaction(payload, state.unsigned),
  );
  assert.deepEqual(
    getEvmTransactionAddresses({
      to: wallet.address,
      accessList: [
        {address: wallet.address.toLowerCase(), storageKeys: []},
        {address: recipient, storageKeys: []},
      ],
      data: otherWallet.address,
    }),
    [wallet.address.toLowerCase(), recipient],
  );
  assert.deepEqual(
    getEvmTransactionAddresses({to: null, data: wallet.address}),
    [],
  );
});
