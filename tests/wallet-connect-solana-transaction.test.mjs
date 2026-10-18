import assert from 'node:assert/strict';
import {createPrivateKey, createPublicKey, sign} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';

import {base58} from '@scure/base';

import {parseSolanaTransaction} from '../.bld/app/@lib/solana-transaction.js';
import {parseWalletConnectRequest} from '../.bld/app/@lib/wallet-connect-request.js';
// eslint-disable-next-line @mufan/scoped-modules, @mufan/import -- Avoid starting platform services.
import {WalletKitService} from '../.bld/app/@services/wallet-kit-service.js';

const CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const OTHER_CHAIN = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const TOPIC = 'solana-transaction-session';
const SINGLE = 'solana_signTransaction';
const BATCH = 'solana_signAllTransactions';
const SEND = 'solana_signAndSendTransaction';

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
const cosigner = signingKey(2);
const outsider = signingKey(3);

function transaction(amount = 1, version = 'legacy', cosigned = false) {
  // Two required signers, System Program, blockhash, and a transfer instruction.
  const message = Uint8Array.from([
    ...(version === 'legacy' ? [] : [0x80]),
    2,
    0,
    1,
    3,
    ...payer.publicKey,
    ...cosigner.publicKey,
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
    ...(version === 'legacy' ? [] : [0]),
  ]);
  const bytes = Uint8Array.from([
    2,
    ...new Uint8Array(64),
    ...(cosigned
      ? sign(null, message, cosigner.privateKey)
      : new Uint8Array(64)),
    ...message,
  ]);

  return {message, bytes, encoded: Buffer.from(bytes).toString('base64')};
}

function request(params, method = SINGLE) {
  return {
    id: 1,
    topic: TOPIC,
    params: {
      chainId: CHAIN,
      request: {
        method,
        params,
        expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
      },
    },
    verifyContext: {
      verified: {origin: 'https://example.com', validation: 'VALID'},
    },
  };
}

function session() {
  return {
    topic: TOPIC,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    namespaces: {
      solana: {
        chains: [CHAIN],
        accounts: [payer, cosigner, outsider].map(
          key => `${CHAIN}:${key.address}`,
        ),
        methods: [SINGLE, BATCH, SEND],
        events: [],
      },
    },
  };
}

function signed(fixture, key = payer) {
  return {
    address: key.address,
    signature: base58.encode(sign(null, fixture.message, key.privateKey)),
  };
}

function setup(context, incoming) {
  const approved = session();
  const sessions = {[TOPIC]: approved};
  const requests = [incoming];
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
  const storage = {set: context.mock.fn(async () => {})};
  const addressBook = {rememberSigned: context.mock.fn(async () => {})};
  const callHistory = {rememberSigned: context.mock.fn(async () => {})};
  const history = {rememberSubmitted: context.mock.fn(async () => {})};
  const solanaHistory = {
    rememberSubmitted: context.mock.fn(async () => {}),
    rememberSigned: context.mock.fn(async () => {}),
  };
  const service = new WalletKitService(
    kit,
    storage,
    addressBook,
    callHistory,
    history,
    solanaHistory,
    {
      [TOPIC]: {
        connectedAt: 1,
        lastActivityAt: 1,
        verified: incoming.verifyContext.verified,
      },
    },
  );

  const reviewed = parseWalletConnectRequest(incoming, approved);
  const approve = results =>
    service.approveSolanaTransactionRequest(
      incoming.id,
      TOPIC,
      reviewed,
      results,
    );

  return {
    service,
    approve,
    kit,
    requests,
    sessions,
    approved,
    storage,
    history,
    solanaHistory,
  };
}

test('single transaction candidates are required and authorized signers, not all connected accounts', () => {
  const fixture = transaction();
  const incoming = request({transaction: fixture.encoded});
  const parsed = parseWalletConnectRequest(incoming, session());

  assert.equal(parsed.method, SINGLE);
  assert.equal(parsed.chainId, CHAIN);
  assert.equal(parsed.transactions.length, 1);
  assert.deepEqual(parsed.transactions[0].addresses, [
    payer.address,
    cosigner.address,
  ]);
  assert.deepEqual(
    parsed.transactions[0].transaction.messageBytes,
    fixture.message,
  );

  incoming.params.request.params.pubkey = cosigner.address;
  assert.deepEqual(
    parseWalletConnectRequest(incoming, session()).transactions[0].addresses,
    [cosigner.address],
  );
});

test('batch preserves order and derives signing candidates independently per transaction', () => {
  const first = transaction(1);
  const second = transaction(2, 0);
  const incoming = request(
    {transactions: [first.encoded, second.encoded]},
    BATCH,
  );
  const approved = session();
  approved.namespaces.solana.accounts = [`${CHAIN}:${cosigner.address}`];
  const parsed = parseWalletConnectRequest(incoming, approved);

  assert.equal(parsed.method, BATCH);
  assert.deepEqual(
    parsed.transactions.map(item => item.addresses),
    [[cosigner.address], [cosigner.address]],
  );
  assert.deepEqual(
    parsed.transactions.map(item => item.transaction.messageBytes),
    [first.message, second.message],
  );
});

test('transaction authorization binds topic, namespace, method, chain and case-sensitive addresses', () => {
  const fixture = transaction();
  for (const change of ['topic', 'namespace', 'method', 'chain', 'account']) {
    const incoming = request({
      transaction: fixture.encoded,
      pubkey: payer.address,
    });
    const approved = session();
    if (change === 'topic') approved.topic = 'other';
    if (change === 'namespace')
      approved.namespaces = {other: approved.namespaces.solana};
    if (change === 'method') approved.namespaces.solana.methods = [BATCH];
    if (change === 'chain') approved.namespaces.solana.chains = [OTHER_CHAIN];
    if (change === 'account') {
      approved.namespaces.solana.accounts = [
        `${CHAIN}:${payer.address.toLowerCase()}`,
      ];
    }
    assert.throws(() => parseWalletConnectRequest(incoming, approved), {
      code: 4100,
    });
  }

  const approved = session();
  approved.namespaces = {[CHAIN]: approved.namespaces.solana};
  assert.equal(
    parseWalletConnectRequest(request({transaction: fixture.encoded}), approved)
      .transactions.length,
    1,
  );
});

test('does not substitute another signer for an explicit unauthorized or non-signing pubkey', () => {
  const fixture = transaction();
  for (const pubkey of [outsider.address, signingKey(4).address]) {
    assert.throws(
      () =>
        parseWalletConnectRequest(
          request({transaction: fixture.encoded, pubkey}),
          session(),
        ),
      {code: 4100},
    );
  }

  const approved = session();
  approved.namespaces.solana.accounts = [`${CHAIN}:${outsider.address}`];
  assert.throws(
    () =>
      parseWalletConnectRequest(
        request({transaction: fixture.encoded}),
        approved,
      ),
    {code: 4100},
  );
});

test('rejects malformed transaction inputs', () => {
  const valid = transaction().encoded;
  for (const [method, params] of [
    [SINGLE, null],
    [SINGLE, []],
    [SINGLE, {}],
    [SINGLE, {transaction: 1}],
    [SINGLE, {transaction: 'bad base64'}],
    [SINGLE, {transaction: valid, pubkey: null}],
    [SINGLE, {transaction: valid, pubkey: 'invalid'}],
    [BATCH, {transactions: []}],
    [BATCH, {transactions: valid}],
    [BATCH, {transactions: [valid, null]}],
    [BATCH, {transactions: [valid, 'invalid']}],
    [SEND, {transactions: [valid]}],
    [SEND, {transaction: valid, pubkey: null}],
  ]) {
    assert.throws(
      () => parseWalletConnectRequest(request(params, method), session()),
      {code: -32602},
    );
  }
});

test('send preserves bytes and signer authorization, with normalized preflight defaults', () => {
  const fixture = transaction(1, 0, true);
  const incoming = request({transaction: fixture.encoded}, SEND);
  const parsed = parseWalletConnectRequest(incoming, session());

  assert.equal(parsed.method, SEND);
  assert.deepEqual(parsed.sendOptions, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  assert.deepEqual(parsed.transactions[0].transaction.bytes, fixture.bytes);
  assert.deepEqual(parsed.transactions[0].addresses, [
    payer.address,
    cosigner.address,
  ]);

  incoming.params.request.params.pubkey = payer.address;
  assert.deepEqual(
    parseWalletConnectRequest(incoming, session()).transactions[0].addresses,
    [payer.address],
  );

  const approved = session();
  approved.namespaces.solana.methods = [SINGLE, BATCH];
  assert.throws(() => parseWalletConnectRequest(incoming, approved), {
    code: 4100,
  });

  incoming.params.request.params.pubkey = outsider.address;
  assert.throws(() => parseWalletConnectRequest(incoming, session()), {
    code: 4100,
  });
});

test('send options accept modern commitments and safe integer limits while omitting unknown fields', () => {
  for (const commitment of ['processed', 'confirmed', 'finalized']) {
    const options = {
      skipPreflight: true,
      preflightCommitment: commitment,
      maxRetries: 0,
      minContextSlot: Number.MAX_SAFE_INTEGER,
    };
    const parsed = parseWalletConnectRequest(
      request(
        {
          transaction: transaction().encoded,
          sendOptions: {...options, encoding: 'base58', unrelated: 1},
        },
        SEND,
      ),
      session(),
    );
    assert.deepEqual(parsed.sendOptions, options);
  }
});

test('send options reject malformed values before signing', () => {
  for (const options of [
    null,
    [],
    false,
    'confirmed',
    {skipPreflight: 1},
    {skipPreflight: null},
    {preflightCommitment: 'invalid'},
    {preflightCommitment: null},
    ...['maxRetries', 'minContextSlot'].flatMap(name =>
      [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null].map(
        value => ({[name]: value}),
      ),
    ),
  ]) {
    assert.throws(
      () =>
        parseWalletConnectRequest(
          request(
            {transaction: transaction().encoded, sendOptions: options},
            SEND,
          ),
          session(),
        ),
      {code: -32602},
    );
  }
});

test('returns one signed transaction plus signature without broadcasting or recording a submission', async context => {
  const fixture = transaction(1, 0, true);
  const incoming = request({
    transaction: fixture.encoded,
    pubkey: payer.address,
  });
  const {service, approve, kit, requests, history, solanaHistory, storage} =
    setup(context, incoming);
  const next = structuredClone(incoming);
  next.id = 2;
  requests.push(next);
  const result = signed(fixture);

  assert.equal(await approve([result]), true);
  const response = kit.respondSessionRequest.mock.calls[0].arguments[0];
  assert.equal(response.topic, TOPIC);
  assert.equal(response.response.id, 1);
  assert.equal(response.response.result.signature, result.signature);
  const returned = parseSolanaTransaction(response.response.result.transaction);
  assert.deepEqual(returned.messageBytes, fixture.message);
  assert.deepEqual(returned.signatures[0], base58.decode(result.signature));
  assert.deepEqual(returned.signatures[1], fixture.bytes.slice(65, 129));
  assert.equal(service.getTransactionSubmission(1), undefined);
  assert.equal(history.rememberSubmitted.mock.callCount(), 0);
  assert.equal(solanaHistory.rememberSubmitted.mock.callCount(), 0);
  assert.deepEqual(
    solanaHistory.rememberSigned.mock.calls[0].arguments.slice(0, 3),
    [CHAIN, payer.address, response.response.result.transaction],
  );
  assert.equal(
    storage.set.mock.calls.some(
      call => call.arguments[0] === 'walletKitTransactionSubmissions',
    ),
    false,
  );
  assert.deepEqual(Array.from(service.requests.values()), [next]);
});

test('returns an ordered batch signed by each independently selected account', async context => {
  const fixtures = [transaction(1), transaction(2, 0)];
  const incoming = request(
    {transactions: fixtures.map(item => item.encoded)},
    BATCH,
  );
  const {approve, kit, solanaHistory} = setup(context, incoming);
  const results = [signed(fixtures[0], cosigner), signed(fixtures[1], payer)];

  assert.equal(await approve(results), true);
  const response =
    kit.respondSessionRequest.mock.calls[0].arguments[0].response;
  assert.deepEqual(Object.keys(response.result), ['transactions']);
  assert.equal(response.result.transactions.length, 2);
  assert.deepEqual(
    solanaHistory.rememberSigned.mock.calls.map(call =>
      call.arguments.slice(0, 3),
    ),
    response.result.transactions.map((encoded, index) => [
      CHAIN,
      results[index].address,
      encoded,
    ]),
  );
  assert.equal(
    solanaHistory.rememberSigned.mock.calls[0].arguments[3],
    solanaHistory.rememberSigned.mock.calls[1].arguments[3],
  );
  response.result.transactions.forEach((encoded, index) => {
    const parsed = parseSolanaTransaction(encoded);
    assert.deepEqual(parsed.messageBytes, fixtures[index].message);
    const signerIndex = parsed.signerAddresses.indexOf(results[index].address);
    assert.deepEqual(
      parsed.signatures[signerIndex],
      base58.decode(results[index].signature),
    );
  });
});

test('single and batch signing await history before publication and retry failed writes without broadcasting', async context => {
  for (const batch of [false, true]) {
    const fixtures = [transaction(1), transaction(2, 0)];
    const incoming = batch
      ? request({transactions: fixtures.map(item => item.encoded)}, BATCH)
      : request({transaction: fixtures[0].encoded, pubkey: cosigner.address});
    const {approve, kit, solanaHistory} = setup(context, incoming);
    const started = Promise.withResolvers();
    const finish = Promise.withResolvers();
    solanaHistory.rememberSigned.mock.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      throw new Error('History storage unavailable');
    });
    const signedValues = [
      signed(fixtures[0], cosigner),
      signed(fixtures[1], payer),
    ].slice(0, batch ? 2 : 1);
    const approving = approve(signedValues);
    await started.promise;
    assert.equal(kit.respondSessionRequest.mock.callCount(), 0);
    finish.resolve();
    await assert.rejects(approving, /History storage unavailable/);
    assert.equal(kit.respondSessionRequest.mock.callCount(), 0);
    assert.equal(await approve(signedValues), true);
    assert.equal(kit.respondSessionRequest.mock.callCount(), 1);
    assert.equal(solanaHistory.rememberSubmitted.mock.callCount(), 0);
    const calls = solanaHistory.rememberSigned.mock.calls;
    assert.deepEqual(
      calls[0].arguments.slice(0, 3),
      calls[batch ? 2 : 1].arguments.slice(0, 3),
    );
  }
});

test('validates the entire batch before publishing any result', async context => {
  const fixtures = [transaction(1), transaction(2)];
  const incoming = request(
    {transactions: fixtures.map(item => item.encoded)},
    BATCH,
  );
  const {service, approve, kit} = setup(context, incoming);

  for (const results of [
    [],
    [signed(fixtures[0])],
    [signed(fixtures[1]), signed(fixtures[0])],
    [signed(fixtures[0]), signed(fixtures[1], outsider)],
    [signed(fixtures[0]), {address: payer.address, signature: 'bad'}],
  ]) {
    await assert.rejects(approve(results));
  }
  assert.equal(kit.respondSessionRequest.mock.callCount(), 0);
  assert.equal(service.requests.has(1), true);
});

test('rechecks current wire bytes, signer restriction and permissions when retrying publication', async context => {
  for (const change of ['bytes', 'pubkey', 'permissions']) {
    const fixture = transaction();
    const incoming = request({transaction: fixture.encoded});
    const {service, approve, kit, approved} = setup(context, incoming);
    kit.respondSessionRequest.mock.mockImplementationOnce(async () => {
      throw new Error('Relay unavailable.');
    });
    await assert.rejects(approve([signed(fixture)]), /Relay unavailable/);
    if (change === 'bytes')
      incoming.params.request.params.transaction = transaction(2).encoded;
    if (change === 'pubkey')
      incoming.params.request.params.pubkey = cosigner.address;
    if (change === 'permissions') approved.namespaces.solana.methods = [];
    await assert.rejects(approve([signed(fixture)]));
    assert.equal(kit.respondSessionRequest.mock.callCount(), 1);
    assert.equal(service.requests.has(1), true);
  }
});

test('successful publication retries retain original bytes and do not require another signature', async context => {
  const fixture = transaction();
  const incoming = request({transaction: fixture.encoded});
  const {service, approve, kit} = setup(context, incoming);
  kit.respondSessionRequest.mock.mockImplementationOnce(async () => {
    throw new Error('Relay unavailable.');
  });
  const results = [signed(fixture)];
  await assert.rejects(approve(results), /Relay unavailable/);
  assert.equal(await approve(results), true);
  assert.deepEqual(
    kit.respondSessionRequest.mock.calls[0].arguments,
    kit.respondSessionRequest.mock.calls[1].arguments,
  );
});

test('binds a response to the reviewed session even when another request reuses its ID', async context => {
  const fixture = transaction();
  const incoming = request({transaction: fixture.encoded});
  const {approve, kit, sessions, requests, approved} = setup(context, incoming);
  const replacement = structuredClone(incoming);
  replacement.topic = 'another-website';
  sessions[replacement.topic] = {...approved, topic: replacement.topic};

  const pending = approve([signed(fixture)]);
  requests.splice(0, 1, replacement);

  await assert.rejects(pending, {code: 4100});
  assert.equal(kit.respondSessionRequest.mock.callCount(), 0);
});

test('rejects changes to the reviewed network, method or existing signature slots', async context => {
  for (const change of ['chain', 'method', 'cosignature']) {
    const fixture = transaction();
    const incoming = request({transaction: fixture.encoded});
    const {approve, kit, approved} = setup(context, incoming);

    if (change === 'chain') {
      incoming.params.chainId = OTHER_CHAIN;
      approved.namespaces.solana.chains.push(OTHER_CHAIN);
      approved.namespaces.solana.accounts.push(
        `${OTHER_CHAIN}:${payer.address}`,
      );
    }
    if (change === 'method') {
      incoming.params.request.method = BATCH;
      incoming.params.request.params = {transactions: [fixture.encoded]};
    }
    if (change === 'cosignature') {
      incoming.params.request.params.transaction = transaction(
        1,
        'legacy',
        true,
      ).encoded;
    }

    await assert.rejects(approve([signed(fixture)]), /no longer matches/);
    assert.equal(kit.respondSessionRequest.mock.callCount(), 0);
  }
});

test('does not switch to a signer that was excluded by the reviewed pubkey', async context => {
  const fixture = transaction();
  const incoming = request({
    transaction: fixture.encoded,
    pubkey: payer.address,
  });
  const {approve, kit} = setup(context, incoming);
  delete incoming.params.request.params.pubkey;

  await assert.rejects(approve([signed(fixture, cosigner)]), {code: 4100});
  assert.equal(kit.respondSessionRequest.mock.callCount(), 0);
});

test('expiry and session removal prevent publication, while explicit Reject remains available', async context => {
  for (const change of ['request', 'session', 'removed']) {
    const fixture = transaction();
    const incoming = request({transaction: fixture.encoded});
    const {service, approve, kit, approved, sessions} = setup(
      context,
      incoming,
    );
    if (change === 'request') incoming.params.request.expiryTimestamp = 1;
    if (change === 'session') approved.expiry = 1;
    if (change === 'removed') delete sessions[TOPIC];
    assert.equal(await approve([signed(fixture)]), false);
    assert.equal(kit.respondSessionRequest.mock.callCount(), 0);
  }

  const {service, approve, kit} = setup(
    context,
    request({transaction: transaction().encoded}),
  );
  await service.rejectRequest(1);
  assert.equal(
    kit.respondSessionRequest.mock.calls[0].arguments[0].response.error.code,
    5000,
  );
});

test('deduplicates concurrent responses and prevents Reject from racing a signed response', async context => {
  const fixture = transaction();
  const incoming = request({transaction: fixture.encoded});
  const {service, approve, kit} = setup(context, incoming);
  const result = [signed(fixture)];
  const first = approve(result);
  const second = approve(result);
  const rejected = service.rejectRequest(1);

  assert.equal(first, second);
  assert.equal(await first, true);
  await rejected;
  assert.equal(kit.respondSessionRequest.mock.callCount(), 1);
  assert.equal(
    kit.respondSessionRequest.mock.calls[0].arguments[0].response.error,
    undefined,
  );
});
