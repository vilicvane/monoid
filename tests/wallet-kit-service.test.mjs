import assert from 'node:assert/strict';
import {EventEmitter, getEventListeners} from 'node:events';
import {mock, test} from 'node:test';

import {buildAuthObject, formatMessage} from '@walletconnect/utils';
import {Wallet} from 'ethers';
import {reaction} from 'mobx';

// eslint-disable-next-line @mufan/scoped-modules, @mufan/import -- Import the service without starting platform services.
import {
  WalletKitService,
  getWalletKitSessionAddresses,
} from '../.bld/app/@services/wallet-kit-service.js';

const TOPIC = 'a'.repeat(64);
const OTHER_TOPIC = 'c'.repeat(64);
const ADDRESS = `0x${'ab'.repeat(20)}`;
const uri = (topic = TOPIC) =>
  `wc:${topic}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`;
const proposal = (topic = TOPIC, id = 1) => ({
  id,
  verifyContext: {
    verified: {
      origin: 'https://example.com',
      validation: 'VALID',
      verifyUrl: 'https://verify.walletconnect.com',
    },
  },
  params: {
    pairingTopic: topic,
    expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
    requiredNamespaces: {
      eip155: {
        chains: ['eip155:1'],
        methods: [],
        events: ['accountsChanged', 'chainChanged'],
      },
    },
    optionalNamespaces: {},
  },
});

function createKit(sessions = {}, requests = []) {
  const events = new EventEmitter();
  const kit = Object.assign(new EventEmitter(), {
    core: {pairing: {events: new EventEmitter()}},
    engine: {signClient: {events}},
    getActiveSessions: mock.fn(() => ({...sessions})),
    getPendingSessionProposals: mock.fn(() => []),
    getPendingSessionRequests: mock.fn(() => [...requests]),
    pair: mock.fn(async () => {}),
    rejectSession: mock.fn(async () => {}),
    respondSessionRequest: mock.fn(async ({response}) => {
      const index = requests.findIndex(request => request.id === response.id);
      if (index !== -1) requests.splice(index, 1);
    }),
    approveSession: mock.fn(async ({namespaces}) => {
      const session = {topic: TOPIC, namespaces};
      sessions[session.topic] = session;
      return session;
    }),
    disconnectSession: mock.fn(async ({topic}) => {
      delete sessions[topic];
    }),
    updateSession: mock.fn(async ({topic, namespaces}) => {
      sessions[topic] = {...sessions[topic], namespaces};
      return {acknowledged: async () => {}};
    }),
    emitSessionEvent: mock.fn(async () => {}),
  });
  return {kit, events, sessions, requests};
}

function createStorage(records = null) {
  const values = new Map([['walletKitSessionRecords', records]]);

  return {
    get: mock.fn(async key => structuredClone(values.get(key))),
    set: mock.fn(async (key, value) => {
      values.set(key, structuredClone(value));
    }),
  };
}

function createAddressBook() {
  return {rememberSigned: mock.fn(async () => {})};
}

function createCallHistory() {
  return {rememberSigned: mock.fn(async () => {})};
}

function setup(sessions = {}, records = {}, requests = []) {
  const context = createKit(sessions, requests);
  const storage = createStorage(records);
  const addressBook = createAddressBook();
  const callHistory = createCallHistory();
  const service = new WalletKitService(
    context.kit,
    storage,
    addressBook,
    callHistory,
    records,
  );
  // WalletKit returns the SDK store's array despite its Record return type.
  context.kit.getPendingSessionProposals.mock.mockImplementation(() =>
    Array.from(service.proposals, ([id, request]) => ({
      id,
      ...request.params,
    })),
  );
  const controller = new AbortController();

  return {...context, service, storage, addressBook, callHistory, controller};
}

async function receiveProposal(
  {kit, service, controller},
  request = proposal(),
) {
  const connected = service.connect(
    uri(request.params.pairingTopic),
    controller.signal,
  );
  kit.emit('session_proposal', request);
  await connected;
  return request;
}

function assertClean(kit, signal) {
  assert.deepEqual(kit.eventNames().sort(), [
    'proposal_expire',
    'session_request',
    'session_request_expire',
  ]);
  assert.equal(kit.listenerCount('proposal_expire'), 1);
  assert.equal(kit.listenerCount('session_request'), 1);
  assert.equal(kit.listenerCount('session_request_expire'), 1);
  assert.deepEqual(kit.core.pairing.events.eventNames().sort(), [
    'pairing_delete',
    'pairing_expire',
  ]);
  for (const event of kit.core.pairing.events.eventNames()) {
    assert.equal(kit.core.pairing.events.listenerCount(event), 1);
  }
  assert.deepEqual(getEventListeners(signal, 'abort'), []);
}

test('session addresses deduplicate chains and namespaces while preserving first spelling and order', () => {
  const first = `0x${'aB'.repeat(20)}`;
  const second = `0x${'cD'.repeat(20)}`;
  const third = `0x${'eF'.repeat(20)}`;
  const session = {
    namespaces: {
      eip155: {
        accounts: [
          `eip155:1:${first}`,
          `eip155:1:${second}`,
          `eip155:10:${first.toLowerCase()}`,
        ],
      },
      'eip155:137': {
        accounts: [
          `eip155:137:${second.toLowerCase()}`,
          `eip155:137:${third}`,
          `eip155:137:${first.toLowerCase()}`,
        ],
      },
    },
  };

  assert.deepEqual(getWalletKitSessionAddresses(session), [
    first,
    second,
    third,
  ]);
});

test('subscribes before pairing and accepts only the scanned topic', async () => {
  const {kit, service, controller} = setup();
  const expected = proposal();
  kit.pair.mock.mockImplementation(async () => {
    kit.emit('session_proposal', proposal(OTHER_TOPIC, 2));
    kit.emit('session_proposal', expected);
  });

  const result = await service.connect(` ${uri()} `, controller.signal);

  assert.equal(result, expected);
  assert.equal(service.proposals.get(expected.id), expected);
  assert.equal(service.proposals.size, 1);
  assert.deepEqual(kit.pair.mock.calls[0].arguments, [{uri: uri()}]);
  assertClean(kit, controller.signal);
});

test('a pre-cancelled or invalid request does not start pairing', async () => {
  const {kit, service, controller} = setup();
  controller.abort();

  assert.equal(await service.connect(uri(), controller.signal), undefined);
  await assert.rejects(
    service.connect('https://example.com', new AbortController().signal),
    /Invalid or expired/,
  );
  assert.equal(kit.pair.mock.callCount(), 0);
  assertClean(kit, controller.signal);
});

test('a replayed proposal cannot hide a subsequent pairing failure', async () => {
  const {kit, service, controller} = setup();
  let failPairing;
  kit.pair.mock.mockImplementationOnce(
    () => new Promise((_resolve, reject) => (failPairing = reject)),
  );
  const failure = new Error('Subscription failed');
  const result = service.connect(uri(), controller.signal);
  const rejected = assert.rejects(result, failure);

  kit.emit('session_proposal', proposal());
  failPairing(failure);

  await rejected;
  assert.equal(service.proposals.size, 0);
  assertClean(kit, controller.signal);
});

test('reject removes a proposal immediately and sends only one rejection', async () => {
  const {kit, service, controller} = setup();
  const expected = proposal();
  const connected = service.connect(uri(), controller.signal);
  kit.emit('session_proposal', expected);
  await connected;

  let finishRejection;
  kit.rejectSession.mock.mockImplementationOnce(
    () => new Promise(resolve => (finishRejection = resolve)),
  );

  const rejected = service.reject(expected.id);

  assert.equal(service.proposals.has(expected.id), false);
  await service.reject(expected.id);
  assert.equal(kit.rejectSession.mock.callCount(), 1);
  const [request] = kit.rejectSession.mock.calls[0].arguments;
  assert.equal(request.id, expected.id);
  assert.equal(request.reason.code, 5000);

  finishRejection();
  await rejected;
  assertClean(kit, controller.signal);
});

test('a failed SDK rejection still clears the local confirmation', async () => {
  const {kit, service, controller} = setup();
  const expected = proposal();
  const connected = service.connect(uri(), controller.signal);
  kit.emit('session_proposal', expected);
  await connected;
  const failure = new Error('Relay unavailable');
  kit.rejectSession.mock.mockImplementationOnce(async () => {
    throw failure;
  });

  await assert.rejects(service.reject(expected.id), failure);

  assert.equal(service.proposals.has(expected.id), false);
  await service.reject(expected.id);
  assert.equal(kit.rejectSession.mock.callCount(), 1);
  assertClean(kit, controller.signal);
});

test('rejecting an expired proposal clears it without calling the SDK', async context => {
  context.mock.timers.enable({apis: ['Date'], now: 1_000_000});
  const {kit, service, controller} = setup();
  const expected = proposal();
  const connected = service.connect(uri(), controller.signal);
  kit.emit('session_proposal', expected);
  await connected;

  context.mock.timers.setTime(expected.params.expiryTimestamp * 1000);
  await service.reject(expected.id);

  assert.equal(service.proposals.has(expected.id), false);
  assert.equal(kit.rejectSession.mock.callCount(), 0);
  assertClean(kit, controller.signal);
});

test('proposal expiry removes only the matching confirmation', async () => {
  const {kit, service, controller} = setup();
  const expected = proposal();
  const other = proposal(OTHER_TOPIC, 2);
  for (const next of [expected, other]) {
    const connected = service.connect(
      uri(next.params.pairingTopic),
      controller.signal,
    );
    kit.emit('session_proposal', next);
    await connected;
  }

  kit.emit('proposal_expire', {id: 3});
  assert.equal(service.proposals.size, 2);
  kit.emit('proposal_expire', {id: expected.id});

  assert.equal(service.proposals.has(expected.id), false);
  assert.equal(service.proposals.get(other.id), other);
  assert.equal(kit.rejectSession.mock.callCount(), 0);
  assertClean(kit, controller.signal);
});

test('pairing expiry or deletion clears only its own confirmations', async () => {
  for (const event of ['pairing_expire', 'pairing_delete']) {
    const {kit, service, controller} = setup();
    const expected = proposal();
    const other = proposal(OTHER_TOPIC, 2);
    for (const next of [expected, other]) {
      const connected = service.connect(
        uri(next.params.pairingTopic),
        controller.signal,
      );
      kit.emit('session_proposal', next);
      await connected;
    }

    kit.core.pairing.events.emit(event, {topic: TOPIC});

    assert.equal(service.proposals.has(expected.id), false);
    assert.equal(service.proposals.get(other.id), other);
    assert.equal(kit.rejectSession.mock.callCount(), 0);
    assertClean(kit, controller.signal);
  }
});

test('cancellation returns while pairing is pending and isolates late failures from a new attempt', async () => {
  const {kit, service, controller} = setup();
  let failPairing;
  kit.pair.mock.mockImplementationOnce(
    () => new Promise((_resolve, reject) => (failPairing = reject)),
  );

  const cancelled = service.connect(uri(), controller.signal);
  controller.abort();
  assert.equal(await cancelled, undefined);
  assertClean(kit, controller.signal);

  const nextController = new AbortController();
  const next = service.connect(uri(OTHER_TOPIC), nextController.signal);
  failPairing(new Error('Late relay failure'));
  kit.emit('session_proposal', proposal());
  const expected = proposal(OTHER_TOPIC);
  kit.emit('session_proposal', expected);

  assert.equal(await next, expected);
  assertClean(kit, nextController.signal);
});

test('overlapping requests cannot replace the pending caller', async () => {
  const {kit, service, controller} = setup();
  const first = service.connect(uri(), controller.signal);

  await assert.rejects(
    service.connect(uri(OTHER_TOPIC), new AbortController().signal),
    /already in progress/,
  );
  assert.equal(kit.pair.mock.callCount(), 1);

  const expected = proposal();
  kit.emit('session_proposal', expected);
  assert.equal(await first, expected);
  assertClean(kit, controller.signal);
});

test('pairing failure releases the next attempt and removes listeners', async () => {
  const {kit, service, controller} = setup();
  const failure = new Error('Relay unavailable');
  kit.pair.mock.mockImplementationOnce(async () => {
    throw failure;
  });

  await assert.rejects(service.connect(uri(), controller.signal), failure);
  assertClean(kit, controller.signal);

  const next = service.connect(uri(), controller.signal);
  kit.emit('session_proposal', proposal());
  assert.ok(await next);
  assertClean(kit, controller.signal);
});

test('waiting is bounded by one minute or the QR expiry, whichever is earlier', async context => {
  context.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 1_000_000});

  for (const [value, duration] of [
    [uri(), 60_000],
    [`${uri()}&expiryTimestamp=1061`, 1000],
  ]) {
    const {kit, service, controller} = setup();
    let settled = false;
    const result = service.connect(value, controller.signal);
    const rejected = assert.rejects(result, /timed out/).then(() => {
      settled = true;
    });

    context.mock.timers.tick(duration - 1);
    await Promise.resolve();
    assert.equal(settled, false);
    context.mock.timers.tick(1);
    await rejected;
    assertClean(kit, controller.signal);
  }
});

test('only a matching pairing expiry or deletion interrupts the wait', async () => {
  for (const event of ['pairing_expire', 'pairing_delete']) {
    const {kit, service, controller} = setup();
    const result = service.connect(uri(), controller.signal);
    const rejected = assert.rejects(result, /request ended/);

    kit.core.pairing.events.emit(event, {topic: OTHER_TOPIC});
    assert.equal(kit.listenerCount('session_proposal'), 1);
    kit.core.pairing.events.emit(event, {topic: TOPIC});

    await rejected;
    assertClean(kit, controller.signal);
  }
});

test('an already expired proposal is not passed to the confirmation page', async () => {
  const {kit, service, controller} = setup();
  const result = service.connect(uri(), controller.signal);
  const rejected = assert.rejects(result, /request expired/);
  const expired = proposal();
  expired.params.expiryTimestamp = Math.floor(Date.now() / 1000);
  kit.emit('session_proposal', expired);

  await rejected;
  assertClean(kit, controller.signal);
});

test('creates an empty service on first installation', async () => {
  const {kit} = createKit();
  const storage = createStorage();

  const service = await WalletKitService.create(
    kit,
    storage,
    createAddressBook(),
    createCallHistory(),
  );

  assert.deepEqual(storage.get.mock.calls[0].arguments, [
    'walletKitSessionRecords',
  ]);
  assert.equal(service.sessions.size, 0);
  assert.equal(service.sessionRecords.size, 0);
  assert.deepEqual(await storage.get('walletKitSessionRecords'), {});
});

test('restores persisted records without changing activity and prunes disconnected topics', async context => {
  context.mock.timers.enable({apis: ['Date'], now: 3_000_000});
  const session = {topic: TOPIC};
  const {kit} = createKit({[TOPIC]: session});
  const record = {
    connectedAt: 1_000_000,
    lastActivityAt: 2_000_000,
    verified: proposal().verifyContext.verified,
  };
  const storage = createStorage({
    [TOPIC]: record,
    [OTHER_TOPIC]: {
      connectedAt: 500_000,
      lastActivityAt: 600_000,
      verified: proposal().verifyContext.verified,
    },
  });

  const service = await WalletKitService.create(
    kit,
    storage,
    createAddressBook(),
    createCallHistory(),
  );

  assert.equal(service.sessions.get(TOPIC), session);
  assert.deepEqual(service.sessionRecords.get(TOPIC), record);
  assert.equal(service.sessionRecords.has(OTHER_TOPIC), false);
  assert.deepEqual(await storage.get('walletKitSessionRecords'), {
    [TOPIC]: record,
  });
});

test('restores SDK sessions and refreshes account and expiry changes', async context => {
  context.mock.timers.enable({apis: ['Date'], now: 1_000_000});
  const initial = {topic: TOPIC, expiry: 1234};
  const record = {
    connectedAt: 800_000,
    lastActivityAt: 900_000,
    verified: proposal().verifyContext.verified,
  };
  const {service, sessions, events, storage} = setup(
    {[TOPIC]: initial},
    {[TOPIC]: record},
  );
  assert.equal(service.sessions.get(TOPIC), initial);
  assert.deepEqual(service.sessionRecords.get(TOPIC), record);

  const updated = {...initial, namespaces: {eip155: {accounts: [ADDRESS]}}};
  sessions[TOPIC] = updated;
  events.emit('session_update', {topic: TOPIC});
  assert.equal(service.sessions.get(TOPIC), updated);
  assert.deepEqual(service.sessionRecords.get(TOPIC), {
    connectedAt: record.connectedAt,
    lastActivityAt: 1_000_000,
    verified: record.verified,
  });

  context.mock.timers.setTime(1_100_000);
  const extended = {...updated, expiry: 5678};
  sessions[TOPIC] = extended;
  events.emit('session_extend', {topic: TOPIC});
  assert.equal(service.sessions.get(TOPIC), extended);
  assert.deepEqual(await storage.get('walletKitSessionRecords'), {
    [TOPIC]: {
      connectedAt: record.connectedAt,
      lastActivityAt: 1_100_000,
      verified: record.verified,
    },
  });
});

test('requests update persisted activity and verification while keeping the connection time', async context => {
  context.mock.timers.enable({apis: ['Date'], now: 1_000_000});
  const session = {topic: TOPIC};
  const record = {
    connectedAt: 800_000,
    lastActivityAt: 900_000,
    verified: proposal().verifyContext.verified,
  };
  const {kit, service, storage, events} = setup(
    {[TOPIC]: session},
    {[TOPIC]: record},
  );
  const verified = {...record.verified, validation: 'INVALID'};

  kit.emit('session_request', {topic: TOPIC, verifyContext: {verified}});

  const expected = {connectedAt: 800_000, lastActivityAt: 1_000_000, verified};
  assert.equal(service.sessions.get(TOPIC), session);
  assert.deepEqual(service.sessionRecords.get(TOPIC), expected);
  assert.deepEqual(await storage.get('walletKitSessionRecords'), {
    [TOPIC]: expected,
  });

  context.mock.timers.setTime(1_100_000);
  events.emit('session_event', {topic: TOPIC});
  assert.deepEqual(service.sessionRecords.get(TOPIC), {
    ...expected,
    lastActivityAt: 1_100_000,
  });
});

test('ping does not change or persist activity', async context => {
  context.mock.timers.enable({apis: ['Date'], now: 1_000_000});
  const record = {
    connectedAt: 800_000,
    lastActivityAt: 900_000,
    verified: proposal().verifyContext.verified,
  };
  const {kit, events, service, storage} = setup(
    {[TOPIC]: {topic: TOPIC}},
    {[TOPIC]: record},
  );
  const writes = storage.set.mock.callCount();

  events.emit('session_ping', {topic: TOPIC});
  kit.emit('session_ping', {topic: TOPIC});

  assert.deepEqual(service.sessionRecords.get(TOPIC), record);
  assert.equal(storage.set.mock.callCount(), writes);
  assert.deepEqual(await storage.get('walletKitSessionRecords'), {
    [TOPIC]: record,
  });
});

test('remote deletion and expiry remove only the matching session and its record', async () => {
  for (const event of ['session_delete', 'session_expire']) {
    const other = {topic: OTHER_TOPIC};
    const otherRecord = {
      connectedAt: 300_000,
      lastActivityAt: 400_000,
      verified: proposal().verifyContext.verified,
    };
    const {service, events, kit, storage} = setup(
      {[TOPIC]: {topic: TOPIC}, [OTHER_TOPIC]: other},
      {
        [TOPIC]: {
          connectedAt: 100_000,
          lastActivityAt: 200_000,
          verified: proposal().verifyContext.verified,
        },
        [OTHER_TOPIC]: otherRecord,
      },
    );

    events.emit(event, {topic: TOPIC});
    assert.equal(service.sessions.has(TOPIC), false);
    assert.equal(service.sessions.get(OTHER_TOPIC), other);
    assert.equal(service.sessionRecords.has(TOPIC), false);
    assert.deepEqual(service.sessionRecords.get(OTHER_TOPIC), otherRecord);
    assert.deepEqual(await storage.get('walletKitSessionRecords'), {
      [OTHER_TOPIC]: otherRecord,
    });
    assert.equal(kit.disconnectSession.mock.callCount(), 0);
  }
});

test('approves selected accounts, removes the proposal and records the resulting connection', async context => {
  context.mock.timers.enable({apis: ['Date'], now: 1_000_000});
  const state = setup();
  const {service, kit, storage} = state;
  const request = await receiveProposal(state);
  const session = await service.approve(request.id, [ADDRESS]);

  assert.deepEqual(kit.approveSession.mock.calls[0].arguments, [
    {
      id: request.id,
      namespaces: {
        eip155: {
          chains: ['eip155:1'],
          methods: [],
          events: ['accountsChanged', 'chainChanged'],
          accounts: [`eip155:1:${ADDRESS}`],
        },
      },
    },
  ]);
  assert.equal(service.proposals.has(request.id), false);
  assert.equal(service.sessions.get(session.topic), session);
  const record = {
    connectedAt: 1_000_000,
    lastActivityAt: 1_000_000,
    verified: request.verifyContext.verified,
  };
  assert.deepEqual(service.sessionRecords.get(session.topic), record);
  assert.deepEqual(await storage.get('walletKitSessionRecords'), {
    [session.topic]: record,
  });
  assert.equal(kit.rejectSession.mock.callCount(), 0);
});

test('coalesces duplicate approval and waits before a leaving page can reject', async () => {
  const context = setup();
  const {service, kit} = context;
  const request = await receiveProposal(context);
  const deferred = Promise.withResolvers();
  kit.approveSession.mock.mockImplementationOnce(() => deferred.promise);

  const approval = service.approve(request.id, [ADDRESS]);
  assert.equal(service.approve(request.id, [ADDRESS]), approval);
  let rejected = false;
  const rejection = service.reject(request.id).then(() => {
    rejected = true;
  });
  await Promise.resolve();
  assert.equal(rejected, false);
  assert.equal(kit.rejectSession.mock.callCount(), 0);

  const session = {topic: TOPIC};
  deferred.resolve(session);
  assert.equal(await approval, session);
  await rejection;
  assert.equal(kit.approveSession.mock.callCount(), 1);
  assert.equal(kit.rejectSession.mock.callCount(), 0);
  assert.equal(service.sessions.get(TOPIC), session);
});

test('failed approval remains retryable and a waiting rejection dismisses it once', async () => {
  const context = setup();
  const {service, kit} = context;
  const request = await receiveProposal(context);
  const failure = new Error('Relay unavailable');
  kit.approveSession.mock.mockImplementationOnce(async () => {
    throw failure;
  });

  await assert.rejects(service.approve(request.id, [ADDRESS]), failure);
  assert.equal(service.proposals.get(request.id), request);

  const deferred = Promise.withResolvers();
  kit.approveSession.mock.mockImplementationOnce(() => deferred.promise);
  const approval = assert.rejects(
    service.approve(request.id, [ADDRESS]),
    failure,
  );
  const rejections = [service.reject(request.id), service.reject(request.id)];
  deferred.reject(failure);
  await Promise.all([approval, ...rejections]);

  assert.equal(kit.approveSession.mock.callCount(), 2);
  assert.equal(kit.rejectSession.mock.callCount(), 1);
  assert.equal(service.proposals.has(request.id), false);
  assert.equal(service.sessions.size, 0);
});

test('reconciles a partially approved session without changing an existing session on the pairing', async context => {
  context.mock.timers.enable({apis: ['Date'], now: 1_000_000});
  const existingSession = {topic: OTHER_TOPIC, pairingTopic: TOPIC};
  const existingRecord = {
    connectedAt: 700_000,
    lastActivityAt: 800_000,
    verified: {
      ...proposal().verifyContext.verified,
      validation: 'UNKNOWN',
    },
  };
  const state = setup(
    {[OTHER_TOPIC]: existingSession},
    {[OTHER_TOPIC]: existingRecord},
  );
  const {service, kit, sessions, storage} = state;
  const request = await receiveProposal(state);
  const session = {topic: TOPIC, pairingTopic: request.params.pairingTopic};
  const failure = new Error('Pairing activation failed');
  kit.approveSession.mock.mockImplementationOnce(async () => {
    sessions[TOPIC] = session;
    kit.getPendingSessionProposals.mock.mockImplementation(() => []);
    context.mock.timers.setTime(1_010_000);
    throw failure;
  });

  await assert.rejects(service.approve(request.id, [ADDRESS]), failure);

  assert.equal(service.sessions.get(TOPIC), session);
  const record = {
    connectedAt: 1_000_000,
    lastActivityAt: 1_000_000,
    verified: request.verifyContext.verified,
  };
  assert.deepEqual(service.sessionRecords.get(TOPIC), record);
  assert.equal(service.sessions.get(OTHER_TOPIC), existingSession);
  assert.deepEqual(service.sessionRecords.get(OTHER_TOPIC), existingRecord);
  assert.deepEqual(await storage.get('walletKitSessionRecords'), {
    [TOPIC]: record,
    [OTHER_TOPIC]: existingRecord,
  });
  assert.equal(service.proposals.has(request.id), false);
  await service.reject(request.id);
  assert.equal(kit.rejectSession.mock.callCount(), 0);
});

test('expired approvals end quietly before or during the SDK operation', async context => {
  context.mock.timers.enable({apis: ['Date'], now: 1_000_000});
  const state = setup();
  const {service, kit} = state;
  const request = await receiveProposal(state);
  context.mock.timers.setTime(request.params.expiryTimestamp * 1000);

  assert.equal(await service.approve(request.id, [ADDRESS]), undefined);
  assert.equal(kit.approveSession.mock.callCount(), 0);
  assert.equal(service.proposals.has(request.id), false);

  const next = await receiveProposal(state, proposal(TOPIC, 2));
  const deferred = Promise.withResolvers();
  kit.approveSession.mock.mockImplementationOnce(() => deferred.promise);
  const approval = service.approve(next.id, [ADDRESS]);
  kit.emit('proposal_expire', {id: next.id});
  deferred.reject(new Error('No matching proposal'));

  assert.equal(await approval, undefined);
  assert.equal(service.proposals.has(next.id), false);
  assert.equal(kit.rejectSession.mock.callCount(), 0);
});

test('unsupported required methods never reach SDK approval', async () => {
  const context = setup();
  const {service, kit} = context;
  const request = proposal();
  request.params.requiredNamespaces.eip155.methods.push('eth_signTypedData_v3');
  await receiveProposal(context, request);

  await assert.rejects(service.approve(request.id, [ADDRESS]), {
    message: 'This site requires unsupported wallet features.',
  });
  assert.equal(kit.approveSession.mock.callCount(), 0);
  assert.equal(service.proposals.get(request.id), request);
});

test('disconnect removes a session only after successful SDK completion', async () => {
  const session = {topic: TOPIC};
  const record = {
    connectedAt: 100_000,
    lastActivityAt: 200_000,
    verified: proposal().verifyContext.verified,
  };
  const {service, kit, storage} = setup({[TOPIC]: session}, {[TOPIC]: record});
  const failure = new Error('Relay unavailable');
  kit.disconnectSession.mock.mockImplementationOnce(async () => {
    throw failure;
  });

  await assert.rejects(service.disconnect(TOPIC), failure);
  assert.equal(service.sessions.get(TOPIC), session);
  assert.deepEqual(service.sessionRecords.get(TOPIC), record);
  assert.deepEqual(await storage.get('walletKitSessionRecords'), {
    [TOPIC]: record,
  });

  await service.disconnect(TOPIC);
  assert.equal(service.sessions.has(TOPIC), false);
  assert.equal(service.sessionRecords.has(TOPIC), false);
  assert.deepEqual(await storage.get('walletKitSessionRecords'), {});
  const [{topic, reason}] = kit.disconnectSession.mock.calls[1].arguments;
  assert.equal(topic, TOPIC);
  assert.equal(reason.code, 6000);

  await service.disconnect(TOPIC);
  assert.equal(kit.disconnectSession.mock.callCount(), 2);
});

function setupSwitchSession(
  namespace = {
    chains: ['eip155:1', 'eip155:137'],
    methods: [],
    events: ['accountsChanged', 'chainChanged'],
    accounts: [`eip155:1:${ADDRESS}`, `eip155:137:${ADDRESS}`],
  },
) {
  return setup(
    {
      [TOPIC]: {topic: TOPIC, namespaces: {eip155: namespace}},
    },
    {
      [TOPIC]: {
        connectedAt: 100_000,
        lastActivityAt: 200_000,
        verified: proposal().verifyContext.verified,
      },
    },
  );
}

test('switch replaces authorized accounts on every approved chain and waits for acknowledgement', async context => {
  context.mock.timers.enable({apis: ['Date'], now: 300_000});
  const {service, kit, sessions, storage} = setupSwitchSession();
  const address = `0x${'cd'.repeat(20)}`;
  const second = `0x${'ef'.repeat(20)}`;
  const original = sessions[TOPIC];
  const latest = {
    ...original,
    namespaces: {
      eip155: {
        ...original.namespaces.eip155,
        chains: ['eip155:1', 'eip155:137', 'eip155:10'],
        methods: ['personal_sign'],
        accounts: [
          ...original.namespaces.eip155.accounts,
          `eip155:10:${ADDRESS}`,
        ],
      },
      other: {accounts: ['other:chain:account'], methods: [], events: []},
    },
  };
  sessions[TOPIC] = latest;
  const acknowledgement = Promise.withResolvers();
  const waiting = Promise.withResolvers();
  kit.updateSession.mock.mockImplementationOnce(async ({topic, namespaces}) => {
    sessions[topic] = {...sessions[topic], namespaces};
    return {
      acknowledged: () => {
        waiting.resolve();
        return acknowledgement.promise;
      },
    };
  });

  assert.equal(service.canSwitchAccount(TOPIC), true);
  const onWaitingForAcknowledgement = mock.fn();
  const switching = service.switchAccounts(
    TOPIC,
    [address, second],
    onWaitingForAcknowledgement,
  );
  await waiting.promise;
  assert.equal(onWaitingForAcknowledgement.mock.callCount(), 1);

  const expectedNamespaces = {
    ...latest.namespaces,
    eip155: {
      ...latest.namespaces.eip155,
      accounts: [
        `eip155:1:${address}`,
        `eip155:1:${second}`,
        `eip155:137:${address}`,
        `eip155:137:${second}`,
        `eip155:10:${address}`,
        `eip155:10:${second}`,
      ],
    },
  };
  assert.deepEqual(kit.updateSession.mock.calls[0].arguments, [
    {
      topic: TOPIC,
      namespaces: expectedNamespaces,
    },
  ]);
  assert.equal(kit.emitSessionEvent.mock.callCount(), 0);
  assert.equal(service.sessionRecords.get(TOPIC).lastActivityAt, 200_000);

  acknowledgement.resolve();
  await switching;
  assert.equal(onWaitingForAcknowledgement.mock.callCount(), 1);

  assert.deepEqual(kit.emitSessionEvent.mock.calls[0].arguments, [
    {
      topic: TOPIC,
      chainId: 'eip155:1',
      event: {name: 'accountsChanged', data: [address, second]},
    },
  ]);
  assert.deepEqual(service.sessions.get(TOPIC).namespaces, expectedNamespaces);
  assert.equal(service.sessionRecords.get(TOPIC).connectedAt, 100_000);
  assert.equal(
    (await storage.get('walletKitSessionRecords'))[TOPIC].lastActivityAt,
    300_000,
  );
});

test('switch deduplicates selected account casing and removes unchecked accounts without an explicit chain list', async () => {
  const chosen = `0x${'Ab'.repeat(20)}`;
  const other = `0x${'cd'.repeat(20)}`;
  const {service, kit} = setupSwitchSession({
    methods: [],
    events: ['accountsChanged'],
    accounts: [
      `eip155:137:${other}`,
      `eip155:137:${ADDRESS}`,
      `eip155:1:${ADDRESS}`,
      `eip155:1:0x${'AB'.repeat(20)}`,
    ],
  });

  await service.switchAccounts(TOPIC, [chosen, chosen.toLowerCase()]);

  const namespace = service.sessions.get(TOPIC).namespaces.eip155;
  assert.deepEqual(namespace.accounts, [
    `eip155:137:${chosen}`,
    `eip155:1:${chosen}`,
  ]);
  assert.equal(namespace.chains, undefined);
  assert.deepEqual(kit.emitSessionEvent.mock.calls[0].arguments[0].event.data, [
    chosen,
  ]);
  assert.equal(
    kit.emitSessionEvent.mock.calls[0].arguments[0].chainId,
    'eip155:137',
  );
});

test('unsupported and missing sessions cannot send an account switch', async () => {
  for (const namespace of [
    undefined,
    {accounts: [], methods: [], events: ['accountsChanged']},
    {accounts: [`eip155:1:${ADDRESS}`], methods: [], events: ['chainChanged']},
  ]) {
    const {service, kit, sessions} = setupSwitchSession();
    sessions[TOPIC] = {
      ...sessions[TOPIC],
      namespaces: namespace ? {eip155: namespace} : {},
    };

    await assert.rejects(
      service.switchAccounts(TOPIC, [ADDRESS]),
      /does not support account switching/,
    );
    assert.equal(service.canSwitchAccount(TOPIC), false);
    assert.equal(service.canSwitchAccount(OTHER_TOPIC), false);
    assert.equal(kit.updateSession.mock.callCount(), 0);
    assert.equal(kit.emitSessionEvent.mock.callCount(), 0);
  }

  const {service, kit, sessions} = setupSwitchSession();
  delete sessions[TOPIC];
  await assert.rejects(
    service.switchAccounts(TOPIC, [ADDRESS]),
    /Session no longer available/,
  );
  assert.equal(service.sessions.has(TOPIC), false);
  assert.equal(service.sessionRecords.has(TOPIC), false);
  assert.equal(kit.updateSession.mock.callCount(), 0);
});

test('a failed update or acknowledgement refreshes SDK state and allows retrying the selected accounts', async () => {
  for (const beforeUpdate of [true, false]) {
    const {service, kit, sessions} = setupSwitchSession();
    const original = sessions[TOPIC];
    const failure = new Error('Session update failed');
    const chosen = `0x${'cd'.repeat(20)}`;
    kit.updateSession.mock.mockImplementationOnce(
      async ({topic, namespaces}) => {
        if (beforeUpdate) throw failure;
        sessions[topic] = {...sessions[topic], namespaces};
        return {
          acknowledged: async () => {
            throw failure;
          },
        };
      },
    );

    const onWaitingForAcknowledgement = mock.fn();
    await assert.rejects(
      service.switchAccounts(TOPIC, [chosen], onWaitingForAcknowledgement),
      failure,
    );
    assert.equal(
      onWaitingForAcknowledgement.mock.callCount(),
      beforeUpdate ? 0 : 1,
    );

    assert.equal(kit.emitSessionEvent.mock.callCount(), 0);
    assert.equal(service.sessions.get(TOPIC), sessions[TOPIC]);
    assert.equal(service.sessions.get(TOPIC) === original, beforeUpdate);
    assert.equal(service.sessionRecords.get(TOPIC).lastActivityAt, 200_000);

    await service.switchAccounts(TOPIC, [chosen]);

    assert.equal(kit.updateSession.mock.callCount(), 2);
    assert.equal(kit.emitSessionEvent.mock.callCount(), 1);
    assert.deepEqual(service.sessions.get(TOPIC).namespaces.eip155.accounts, [
      `eip155:1:${chosen}`,
      `eip155:137:${chosen}`,
    ]);
  }
});

test('a session disappearing during acknowledgement prevents the account event', async () => {
  const {service, kit, sessions} = setupSwitchSession();
  kit.updateSession.mock.mockImplementationOnce(async () => ({
    acknowledged: async () => {
      delete sessions[TOPIC];
    },
  }));

  await assert.rejects(
    service.switchAccounts(TOPIC, [ADDRESS]),
    /Session no longer available/,
  );

  assert.equal(service.sessions.has(TOPIC), false);
  assert.equal(service.sessionRecords.has(TOPIC), false);
  assert.equal(kit.emitSessionEvent.mock.callCount(), 0);
});

test('a failed account event preserves the acknowledged authorization and can be retried', async context => {
  context.mock.timers.enable({apis: ['Date'], now: 300_000});
  const {service, kit, sessions} = setupSwitchSession();
  const chosen = `0x${'cd'.repeat(20)}`;
  const failure = new Error('Event publish failed');
  kit.emitSessionEvent.mock.mockImplementationOnce(async () => {
    throw failure;
  });

  await assert.rejects(service.switchAccounts(TOPIC, [chosen]), failure);

  assert.equal(service.sessions.get(TOPIC), sessions[TOPIC]);
  assert.equal(
    service.sessions.get(TOPIC).namespaces.eip155.accounts[0],
    `eip155:1:${chosen}`,
  );
  assert.equal(service.sessionRecords.get(TOPIC).lastActivityAt, 300_000);

  await service.switchAccounts(TOPIC, [chosen]);

  assert.equal(kit.emitSessionEvent.mock.callCount(), 2);
  assert.deepEqual(kit.emitSessionEvent.mock.calls[1].arguments[0].event.data, [
    chosen,
  ]);
  assert.deepEqual(getWalletKitSessionAddresses(service.sessions.get(TOPIC)), [
    chosen,
  ]);
});

test('an empty account selection cannot update the session', async () => {
  const {service, kit, sessions} = setupSwitchSession();
  const original = sessions[TOPIC];

  await assert.rejects(
    service.switchAccounts(TOPIC, []),
    /Choose at least one account/,
  );

  assert.equal(kit.updateSession.mock.callCount(), 0);
  assert.equal(kit.emitSessionEvent.mock.callCount(), 0);
  assert.equal(service.sessions.get(TOPIC), original);
});

// Public test keys; never use these accounts for funds.
const authenticationWallets = [1, 2].map(
  value => new Wallet(`0x${value.toString(16).padStart(64, '0')}`),
);
const authenticationAddresses = authenticationWallets.map(
  wallet => wallet.address,
);

function authenticationProposal() {
  const request = proposal();
  request.params.requiredNamespaces.eip155.chains.push('eip155:137');
  request.params.requests = {
    authentication: [
      {
        type: 'caip122',
        version: '1',
        domain: 'example.com',
        aud: 'https://example.com/login',
        nonce: 'publicnonce123',
        iat: new Date().toISOString(),
        chains: ['eip155:1', 'eip155:137'],
      },
    ],
  };
  return request;
}

async function signAuthentication(request) {
  const auth = request.params.requests.authentication[0];
  return Promise.all(
    auth.chains.flatMap(chain =>
      authenticationWallets.map(async wallet => {
        const iss = `did:pkh:${chain}:${wallet.address}`;
        const signature = await wallet.signMessage(formatMessage(auth, iss));
        return buildAuthObject(auth, {t: 'eip191', s: signature}, iss);
      }),
    ),
  );
}

test('forwards all selected account and chain authentication results with session approval', async () => {
  const state = setup();
  const {service, kit} = state;
  const request = await receiveProposal(state, authenticationProposal());
  const authentication = await signAuthentication(request);

  const session = await service.approve(
    request.id,
    authenticationAddresses,
    authentication,
  );

  assert.equal(kit.approveSession.mock.callCount(), 1);
  const [approved] = kit.approveSession.mock.calls[0].arguments;
  assert.deepEqual(approved.proposalRequestsResponses, {authentication});
  assert.deepEqual(approved.namespaces.eip155.methods, []);
  assert.deepEqual(
    approved.namespaces.eip155.accounts,
    ['eip155:1', 'eip155:137'].flatMap(chain =>
      authenticationAddresses.map(address => `${chain}:${address}`),
    ),
  );
  assert.equal(service.proposals.has(request.id), false);
  assert.equal(service.sessions.get(session.topic), session);
});

test('missing, partial and changed authentication cannot approve a session', async () => {
  const state = setup();
  const {service, kit} = state;
  const request = await receiveProposal(state, authenticationProposal());
  const authentication = await signAuthentication(request);
  const changed = structuredClone(authentication);
  changed[0].p.nonce = 'anothernonce123';
  const anotherAccount = structuredClone(authentication);
  anotherAccount[0].p.iss = `did:pkh:eip155:1:${ADDRESS}`;

  for (const results of [
    undefined,
    authentication.slice(1),
    changed,
    anotherAccount,
  ]) {
    await assert.rejects(
      service.approve(request.id, authenticationAddresses, results),
      /Sign all selected accounts before connecting/,
    );
  }
  assert.equal(kit.approveSession.mock.callCount(), 0);
  assert.equal(service.proposals.get(request.id), request);
  assert.equal(service.sessions.size, 0);

  await service.approve(request.id, authenticationAddresses, authentication);
  assert.equal(kit.approveSession.mock.callCount(), 1);
});

test('authentication expiring during card signing prevents approval even while the proposal remains valid', async context => {
  context.mock.timers.enable({apis: ['Date'], now: 1_000_000});
  const state = setup();
  const {service, kit} = state;
  const request = authenticationProposal();
  request.params.requests.authentication[0].exp = new Date(
    1_010_000,
  ).toISOString();
  await receiveProposal(state, request);
  const authentication = await signAuthentication(request);
  context.mock.timers.setTime(1_010_000);

  assert.equal(
    await service.approve(request.id, authenticationAddresses, authentication),
    undefined,
  );
  assert.equal(kit.approveSession.mock.callCount(), 0);
  assert.equal(service.proposals.has(request.id), false);
  assert.equal(service.sessions.size, 0);
});

function sessionRequest(id, topic = TOPIC, expiryTimestamp) {
  return {
    id,
    topic,
    params: {
      chainId: 'eip155:1',
      request: {
        method: 'personal_sign',
        params: ['0x48656c6c6f', ADDRESS],
        expiryTimestamp,
      },
    },
    verifyContext: proposal().verifyContext,
  };
}

test('restores pending requests in SDK order without expired or disconnected requests', context => {
  context.mock.timers.enable({apis: ['Date'], now: 1_000_000});
  const first = sessionRequest(3, TOPIC, 1100);
  const second = sessionRequest(1);
  const requests = [
    first,
    second,
    sessionRequest(2, TOPIC, 1000),
    sessionRequest(4, OTHER_TOPIC, 1100),
  ];
  const {service} = setup({[TOPIC]: {topic: TOPIC}}, {}, requests);

  assert.deepEqual(Array.from(service.requests.values()), [first, second]);
  assert.equal(service.requests.get(first.id), first);
  assert.equal(requests.length, 4);
});

test('incoming requests preserve the SDK queue and expiry removes only its own request', () => {
  const {kit, service, requests} = setup({[TOPIC]: {topic: TOPIC}});
  const first = sessionRequest(2);
  const second = sessionRequest(1);
  requests.push(first);
  kit.emit('session_request', first);
  requests.push(second);
  kit.emit('session_request', second);
  kit.emit('session_request', first);

  assert.deepEqual(Array.from(service.requests.values()), [first, second]);

  requests.splice(0, 1);
  kit.emit('session_request_expire', {id: first.id});
  assert.deepEqual(Array.from(service.requests.values()), [second]);
  assert.equal(service.sessions.has(TOPIC), true);
});

test('local disconnect, remote deletion and session expiry clear only their pending requests', async () => {
  for (const event of ['disconnect', 'session_delete', 'session_expire']) {
    const other = sessionRequest(2, OTHER_TOPIC);
    const {kit, events, service, sessions} = setup(
      {[TOPIC]: {topic: TOPIC}, [OTHER_TOPIC]: {topic: OTHER_TOPIC}},
      {},
      [sessionRequest(1), other, sessionRequest(3)],
    );

    if (event === 'disconnect') {
      await service.disconnect(TOPIC);
    } else {
      delete sessions[TOPIC];
      events.emit(event, {topic: TOPIC});
    }

    assert.deepEqual(Array.from(service.requests.values()), [other]);
    // A later refresh must not restore requests from the disconnected session.
    kit.emit('session_request', other);
    assert.deepEqual(Array.from(service.requests.values()), [other]);
  }
});

function signingData() {
  return {
    domain: {name: 'Monoid test', chainId: 1},
    types: {
      EIP712Domain: [
        {name: 'name', type: 'string'},
        {name: 'chainId', type: 'uint256'},
      ],
      Confirmation: [{name: 'nonce', type: 'uint256'}],
    },
    primaryType: 'Confirmation',
    message: {nonce: '9007199254740993'},
  };
}

function signingAddressData() {
  const data = signingData();
  data.domain.verifyingContract = ADDRESS;
  data.types.EIP712Domain.push({name: 'verifyingContract', type: 'address'});
  data.types.Confirmation.push(
    {name: 'sender', type: 'address'},
    {name: 'people', type: 'Person[]'},
    {name: 'recipients', type: 'address[2][]'},
    {name: 'memo', type: 'string'},
  );
  data.types.Person = [{name: 'wallet', type: 'address'}];
  Object.assign(data.message, {
    sender: authenticationWallets[0].address,
    people: [{wallet: authenticationWallets[1].address}],
    recipients: [[ADDRESS, authenticationWallets[1].address.toLowerCase()]],
    memo: `An address written as text: 0x${'cd'.repeat(20)}`,
  });
  return data;
}

function signTypedData(wallet, data) {
  return wallet.signTypedData(
    data.domain,
    Object.fromEntries(
      Object.entries(data.types).filter(([type]) => type !== 'EIP712Domain'),
    ),
    data.message,
  );
}

function setupSigning(
  method = 'personal_sign',
  data = method === 'eth_signTypedData_v4' ? signingData() : undefined,
) {
  const wallet = authenticationWallets[0];
  const message = new TextEncoder().encode('Hello');
  const request = sessionRequest(1, TOPIC, Math.floor(Date.now() / 1000) + 300);
  request.params.request.method = method;
  request.params.request.params = data
    ? [wallet.address, JSON.stringify(data)]
    : ['0x48656c6c6f', wallet.address];
  const session = {
    topic: TOPIC,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    namespaces: {
      eip155: {
        chains: ['eip155:1'],
        methods: [method],
        events: [],
        accounts: [`eip155:1:${wallet.address}`],
      },
    },
  };
  return {
    ...setup({[TOPIC]: session}, {}, [request]),
    request,
    wallet,
    message,
    data,
    sign: () =>
      data ? signTypedData(wallet, data) : wallet.signMessage(message),
  };
}

test('receiving or rejecting typed data does not record its addresses as signed', async () => {
  const {service, kit, request, addressBook} = setupSigning(
    'eth_signTypedData_v4',
    signingAddressData(),
  );
  assert.equal(service.requests.get(request.id), request);
  kit.emit('session_request', request);
  assert.equal(addressBook.rememberSigned.mock.callCount(), 0);

  await service.rejectRequest(request.id);

  assert.equal(addressBook.rememberSigned.mock.callCount(), 0);
  assert.equal(service.requests.size, 0);
});

test('verified typed signatures share EVM history across networks and record only typed address fields before publication', async () => {
  for (const chainId of [1, 137]) {
    const data = signingAddressData();
    data.domain.chainId = chainId;
    const {service, kit, sessions, request, requests, sign, addressBook} =
      setupSigning('eth_signTypedData_v4', data);
    const requestChain = `eip155:${chainId}`;
    request.params.chainId = requestChain;
    sessions[TOPIC].namespaces.eip155.chains = [requestChain];
    sessions[TOPIC].namespaces.eip155.accounts = [
      `${requestChain}:${authenticationWallets[0].address}`,
    ];
    kit.respondSessionRequest.mock.mockImplementationOnce(async () => {
      assert.equal(addressBook.rememberSigned.mock.callCount(), 1);
      requests.splice(0, 1);
    });

    assert.equal(await service.approveRequest(1, await sign()), true);

    const [chain, addresses] =
      addressBook.rememberSigned.mock.calls[0].arguments;
    assert.equal(chain, 'evm');
    assert.deepEqual(addresses, [
      ADDRESS,
      authenticationWallets[0].address.toLowerCase(),
      authenticationWallets[1].address.toLowerCase(),
    ]);
  }
});

test('a relay failure does not undo the fact that typed addresses were signed', async () => {
  const {service, kit, sign, addressBook} = setupSigning(
    'eth_signTypedData_v4',
    signingAddressData(),
  );
  const failure = new Error('Relay unavailable');
  kit.respondSessionRequest.mock.mockImplementationOnce(async () => {
    throw failure;
  });

  await assert.rejects(service.approveRequest(1, await sign()), failure);

  assert.equal(addressBook.rememberSigned.mock.callCount(), 1);
  assert.equal(service.requests.has(1), true);
});

test('a history storage failure is reported without preventing a valid signature response', async context => {
  const {service, kit, sign, addressBook} = setupSigning(
    'eth_signTypedData_v4',
    signingAddressData(),
  );
  const failure = new Error('Storage unavailable');
  const error = context.mock.method(console, 'error', () => {});
  addressBook.rememberSigned.mock.mockImplementationOnce(async () => {
    throw failure;
  });

  assert.equal(await service.approveRequest(1, await sign()), true);

  assert.deepEqual(error.mock.calls[0].arguments, [failure]);
  assert.equal(kit.respondSessionRequest.mock.callCount(), 1);
  assert.equal(service.requests.size, 0);
});

test('personal and typed signing return verified signatures and advance a mixed queue in order', async () => {
  const {service, kit, sessions, requests, wallet, sign, addressBook} =
    setupSigning();
  sessions[TOPIC].namespaces.eip155.methods.push('eth_signTypedData_v4');
  const data = signingData();
  const second = structuredClone(requests[0]);
  second.id = 2;
  second.params.request.method = 'eth_signTypedData_v4';
  second.params.request.params = [wallet.address, JSON.stringify(data)];
  requests.push(second);
  kit.emit('session_request', second);
  const signature = await sign();

  assert.equal(await service.approveRequest(1, signature), true);
  assert.equal(addressBook.rememberSigned.mock.callCount(), 0);
  assert.deepEqual(kit.respondSessionRequest.mock.calls[0].arguments, [
    {topic: TOPIC, response: {id: 1, jsonrpc: '2.0', result: signature}},
  ]);
  assert.deepEqual(Array.from(service.requests.values()), [second]);
  assert.equal(await service.approveRequest(1, signature), false);
  assert.equal(kit.respondSessionRequest.mock.callCount(), 1);

  const typedSignature = await signTypedData(wallet, data);
  assert.equal(await service.approveRequest(2, typedSignature), true);
  assert.deepEqual(kit.respondSessionRequest.mock.calls[1].arguments, [
    {topic: TOPIC, response: {id: 2, jsonrpc: '2.0', result: typedSignature}},
  ]);
  assert.equal(service.requests.size, 0);
});

test('rejecting a request sends a user rejection and removes it from the queue', async () => {
  const {service, kit} = setupSigning();

  await service.rejectRequest(1);
  await service.rejectRequest(1);

  assert.deepEqual(kit.respondSessionRequest.mock.calls[0].arguments, [
    {
      topic: TOPIC,
      response: {
        id: 1,
        jsonrpc: '2.0',
        error: {code: 5000, message: 'User rejected.'},
      },
    },
  ]);
  assert.equal(kit.respondSessionRequest.mock.callCount(), 1);
  assert.equal(service.requests.size, 0);
});

test('concurrent approvals and leaving during publication share one response', async () => {
  const {service, kit, requests, wallet, message} = setupSigning();
  const publication = Promise.withResolvers();
  kit.respondSessionRequest.mock.mockImplementationOnce(async () => {
    await publication.promise;
    requests.splice(0, 1);
  });
  const signature = await wallet.signMessage(message);
  const first = service.approveRequest(1, signature);
  const duplicate = service.approveRequest(1, signature);
  const leaving = service.rejectRequest(1);

  assert.equal(first, duplicate);
  await Promise.resolve();
  assert.equal(kit.respondSessionRequest.mock.callCount(), 1);
  assert.equal(service.requests.has(1), true);

  publication.resolve();
  assert.deepEqual(await Promise.all([first, duplicate, leaving]), [
    true,
    true,
    undefined,
  ]);
  assert.equal(kit.respondSessionRequest.mock.callCount(), 1);
  assert.equal(service.requests.size, 0);
});

test('an approval arriving during rejection cannot publish a signed response', async () => {
  const {service, kit, wallet, message} = setupSigning();
  const signature = await wallet.signMessage(message);
  const rejection = service.rejectRequest(1);
  const approval = service.approveRequest(1, signature);
  await Promise.all([rejection, approval]);

  assert.equal(kit.respondSessionRequest.mock.callCount(), 1);
  assert.equal(
    kit.respondSessionRequest.mock.calls[0].arguments[0].response.error.code,
    5000,
  );
});

test('response state updates observers and a failed signed response is not replaced by a leaving rejection', async () => {
  const {service, kit, wallet, message} = setupSigning();
  const publication = Promise.withResolvers();
  const failure = new Error('Response publication failed');
  kit.respondSessionRequest.mock.mockImplementationOnce(
    () => publication.promise,
  );
  const states = [];
  const dispose = reaction(
    () => service.isRespondingToRequest(1),
    value => states.push(value),
    {fireImmediately: true},
  );
  const signature = await wallet.signMessage(message);
  const approval = service.approveRequest(1, signature);
  const leaving = service.rejectRequest(1);
  const settled = Promise.allSettled([approval, leaving]);
  assert.deepEqual(states, [false, true]);

  publication.reject(failure);
  const results = await settled;
  assert.ok(
    results.every(
      result => result.status === 'rejected' && result.reason === failure,
    ),
  );
  assert.equal(kit.respondSessionRequest.mock.callCount(), 1);
  assert.equal(service.requests.has(1), true);
  assert.deepEqual(states, [false, true, false]);

  assert.equal(await service.approveRequest(1, signature), true);
  assert.equal(kit.respondSessionRequest.mock.callCount(), 2);
  assert.deepEqual(states, [false, true, false, true, false]);
  dispose();
});

for (const method of ['personal_sign', 'eth_signTypedData_v4']) {
  test(`${method} response failure remains retryable only while the SDK retains the request`, async () => {
    for (const consumed of [false, true]) {
      const {service, kit, requests, sign} = setupSigning(method);
      const failure = new Error('Response publication failed');
      kit.respondSessionRequest.mock.mockImplementationOnce(async () => {
        if (consumed) requests.splice(0, 1);
        throw failure;
      });
      const signature = await sign();

      if (consumed) {
        assert.equal(await service.approveRequest(1, signature), true);
        assert.equal(await service.approveRequest(1, signature), false);
        assert.equal(kit.respondSessionRequest.mock.callCount(), 1);
      } else {
        await assert.rejects(service.approveRequest(1, signature), failure);
        assert.equal(service.requests.has(1), true);
        assert.equal(await service.approveRequest(1, signature), true);
        assert.equal(kit.respondSessionRequest.mock.callCount(), 2);
      }
      assert.equal(service.requests.size, 0);
    }
  });
}

test('expired requests, expired sessions and disconnected sessions cannot send a response', async () => {
  for (const method of ['personal_sign', 'eth_signTypedData_v4']) {
    for (const change of ['request', 'session', 'disconnect']) {
      const {service, kit, sessions, request, sign, addressBook} =
        setupSigning(method);
      const signature = await sign();
      if (change === 'request') request.params.request.expiryTimestamp = 1;
      else if (change === 'session') sessions[TOPIC].expiry = 1;
      else delete sessions[TOPIC];

      assert.equal(await service.approveRequest(1, signature), false);
      await service.rejectRequest(1);
      assert.equal(kit.respondSessionRequest.mock.callCount(), 0);
      assert.equal(addressBook.rememberSigned.mock.callCount(), 0);
      assert.equal(service.requests.size, 0);
    }
  }
});

test('expiry and disconnect during response publication finish quietly', async () => {
  for (const change of ['request', 'session', 'disconnect']) {
    const {service, kit, sessions, request, wallet, message} = setupSigning();
    const signature = await wallet.signMessage(message);
    kit.respondSessionRequest.mock.mockImplementationOnce(async () => {
      if (change === 'request') request.params.request.expiryTimestamp = 1;
      else if (change === 'session') sessions[TOPIC].expiry = 1;
      else delete sessions[TOPIC];
      throw new Error('Request no longer available');
    });

    assert.equal(await service.approveRequest(1, signature), false);
    assert.equal(service.requests.size, 0);
  }
});

test('responding rechecks current method, chain and account authorization', async () => {
  for (const method of ['personal_sign', 'eth_signTypedData_v4']) {
    for (const change of ['method', 'chain', 'account']) {
      const {service, kit, sessions, sign, addressBook} = setupSigning(method);
      const signature = await sign();
      const namespace = structuredClone(sessions[TOPIC].namespaces.eip155);
      if (change === 'method') namespace.methods = [];
      else if (change === 'chain') namespace.chains = ['eip155:137'];
      else namespace.accounts = [`eip155:1:${ADDRESS}`];
      sessions[TOPIC] = {...sessions[TOPIC], namespaces: {eip155: namespace}};

      await assert.rejects(service.approveRequest(1, signature), {code: 4100});
      assert.equal(kit.respondSessionRequest.mock.callCount(), 0);
      assert.equal(addressBook.rememberSigned.mock.callCount(), 0);
      assert.equal(service.requests.has(1), true);
    }
  }
});

test('a signature for another account or different bytes never reaches the SDK', async () => {
  const {service, kit, wallet, message} = setupSigning();
  for (const signature of [
    await authenticationWallets[1].signMessage(message),
    await wallet.signMessage('0x48656c6c6f'),
  ]) {
    await assert.rejects(
      service.approveRequest(1, signature),
      /signature does not match/,
    );
  }
  assert.equal(kit.respondSessionRequest.mock.callCount(), 0);
  assert.equal(service.requests.has(1), true);
});

test('typed signatures for another account, domain or message never reach the SDK', async () => {
  const {service, kit, wallet, data, addressBook} = setupSigning(
    'eth_signTypedData_v4',
  );
  for (const signature of [
    await signTypedData(authenticationWallets[1], data),
    await signTypedData(wallet, {
      ...data,
      domain: {...data.domain, name: 'Other'},
    }),
    await signTypedData(wallet, {
      ...data,
      message: {nonce: '9007199254740994'},
    }),
    await wallet.signMessage(JSON.stringify(data)),
  ]) {
    await assert.rejects(
      service.approveRequest(1, signature),
      /signature does not match/,
    );
  }
  assert.equal(kit.respondSessionRequest.mock.callCount(), 0);
  assert.equal(addressBook.rememberSigned.mock.callCount(), 0);
  assert.equal(service.requests.has(1), true);
});

test('a retained typed signature cannot answer a request that changes before retry', async () => {
  const {service, kit, request, data, sign} = setupSigning(
    'eth_signTypedData_v4',
  );
  const failure = new Error('Response publication failed');
  kit.respondSessionRequest.mock.mockImplementationOnce(async () => {
    throw failure;
  });
  const signature = await sign();
  await assert.rejects(service.approveRequest(1, signature), failure);

  data.message.nonce = '9007199254740994';
  request.params.request.params[1] = JSON.stringify(data);
  await assert.rejects(
    service.approveRequest(1, signature),
    /signature does not match/,
  );
  assert.equal(kit.respondSessionRequest.mock.callCount(), 1);
  assert.equal(service.requests.has(1), true);
});
