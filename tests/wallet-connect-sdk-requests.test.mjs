import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {
  SSH_EVENTS,
  SSH_METADATA_EVENT,
  SSH_METADATA_METHOD,
  SSH_METHODS,
} from '@monoid/ssh-protocol';
import {RELAYER_EVENTS} from '@walletconnect/core';
import {SignClient} from '@walletconnect/sign-client';

import {WALLET_CONNECT_SIGN_CONFIG} from '../.bld/app/@lib/wallet-connect.js';
import {WalletKitService} from '../.bld/app/@services/wallet-kit-service.js';

const account =
  'monoid:ssh:ed25519.d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const verification = {
  verified: {origin: 'https://example.invalid', validation: 'UNKNOWN'},
};

// Run the installed engine with its real request queue, validators and response
// cleanup. Core is never constructed; verification, storage and transport are memory-only.
function fixture() {
  const core = {
    customStoragePrefix: '',
    linkModeSupportedApps: [],
    pairing: {events: new EventEmitter()},
    relayer: new EventEmitter(),
    expirer: {set() {}, del() {}},
    eventClient: {createEvent: () => ({addTrace() {}, setError() {}})},
  };
  const client = new SignClient({
    core,
    logger: 'silent',
    signConfig: WALLET_CONNECT_SIGN_CONFIG,
    metadata: {
      name: 'Offline fixture',
      description: '',
      url: 'https://example.invalid',
      icons: [],
    },
  });
  const sessions = {};
  for (const topic of ['first', 'second']) {
    sessions[topic] = {
      topic,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      peer: {metadata: {}},
      transportType: 'relay',
      namespaces: {
        monoid: {
          chains: ['monoid:ssh'],
          accounts: [account],
          methods: [...SSH_METHODS],
          events: [...SSH_EVENTS],
        },
      },
    };
  }
  sessions.wallet = {
    topic: 'wallet',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    peer: {metadata: {}},
    transportType: 'relay',
    namespaces: {
      eip155: {
        chains: ['eip155:1'],
        accounts: [`eip155:1:0x${'ab'.repeat(20)}`],
        methods: ['personal_sign'],
        events: [],
      },
      solana: {
        chains: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
        accounts: [
          'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:11111111111111111111111111111111',
        ],
        methods: ['solana_signMessage'],
        events: [],
      },
    },
  };
  const pending = new Map();
  client.session = {
    get: topic => sessions[topic],
    getAll: () => Object.values(sessions),
  };
  client.pendingRequest = {
    set: async (id, value) => pending.set(id, value),
    get: id => pending.get(id),
    getAll: () => [...pending.values()],
    delete: async id => pending.delete(id),
  };
  const engine = client.engine;
  engine.isInitialized = () => {};
  engine.isValidSessionTopic = async () => {};
  engine.confirmOnlineStateOrThrow = async () => {};
  engine.getVerifyContext = async () => verification;
  engine.requestQueueDelay = 0;
  const responses = [];
  const metadataEvents = [];
  engine.sendResult = async value => responses.push(value);
  engine.sendError = async value => responses.push(value);
  const kit = Object.assign(client.events, {
    core,
    engine: {signClient: client},
    getActiveSessions: () => sessions,
    getPendingSessionRequests: () => client.getPendingSessionRequests(),
    respondSessionRequest: params => client.respond(params),
    emitSessionEvent: async value => metadataEvents.push(value),
  });
  const values = new Map();
  const storage = {
    get: async key => values.get(key),
    set: async (key, value) => values.set(key, structuredClone(value)),
  };
  const history = {rememberSubmitted: async () => {}};
  const service = new WalletKitService(
    kit,
    storage,
    {},
    {},
    history,
    history,
    {},
    {},
    {},
    undefined,
    () => false,
    () => [
      {
        type: 'ed25519',
        index: '05010000000000000000',
        account,
        alias: 'My key',
      },
    ],
  );
  const deliver = (
    id,
    topic = 'first',
    chainId = 'monoid:ssh',
    method = 'monoid_sshSign',
  ) =>
    engine.onSessionRequest({
      topic,
      transportType: 'relay',
      payload: {
        id,
        jsonrpc: '2.0',
        params: {
          chainId,
          request: {
            method,
            expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
            params:
              method === SSH_METADATA_METHOD
                ? {}
                : {
                    account,
                    algorithm: 'ssh-ed25519',
                    data: 'aGVsbG8=',
                    expiresAt: Math.floor(Date.now() / 1000) + 90,
                  },
          },
        },
      },
    });
  return {
    service,
    sessions,
    client,
    pending,
    responses,
    deliver,
    core,
    metadataEvents,
  };
}

test('real SDK metadata bypasses an active signing request and never becomes a UI approval', async () => {
  const f = fixture();
  await f.service.ssh.registerSession(f.sessions.first);
  await f.deliver(1);
  await setImmediate();
  assert.equal(f.service.ssh.pending.size, 1);
  await f.deliver(2, 'first', 'monoid:ssh', SSH_METADATA_METHOD);
  await setImmediate();
  assert.equal(f.responses[0].id, 2);
  assert.equal(f.responses[0].topic, 'first');
  assert.deepEqual(f.responses[0].result, {keys: [{account, name: 'My key'}]});
  assert.equal(f.service.ssh.pending.size, 1);
  assert.equal(f.service.requests.size, 1);
  assert.deepEqual([...f.service.requests.keys()], [1]);
  assert.equal(f.pending.has(2), false);
  await f.service.ssh.reject([...f.service.ssh.pending.values()][0]);
});

test('relay reconnection invalidates metadata only for durable locally authorized sessions', async () => {
  const f = fixture();
  await f.service.ssh.registerSession(f.sessions.first);
  await setImmediate();
  f.metadataEvents.length = 0;
  f.core.relayer.emit(RELAYER_EVENTS.connect);
  await setImmediate();
  assert.deepEqual(f.metadataEvents, [
    {
      topic: 'first',
      chainId: 'monoid:ssh',
      event: {name: SSH_METADATA_EVENT, data: {}},
    },
  ]);
});

test('a metadata response awaiting transport does not make a following signing request Busy', async () => {
  const f = fixture();
  await f.service.ssh.registerSession(f.sessions.first);
  const gate = Promise.withResolvers();
  const send = f.client.engine.sendResult;
  f.client.engine.sendResult = async value => {
    if (value.id === 1) await gate.promise;
    await send(value);
  };
  await f.deliver(1, 'first', 'monoid:ssh', SSH_METADATA_METHOD);
  await setImmediate();
  assert.ok(f.pending.has(1));
  assert.equal(f.service.requests.size, 0);
  await f.deliver(2);
  await setImmediate();
  assert.equal(f.service.ssh.pending.size, 1);
  assert.equal(f.responses.length, 0);
  gate.resolve();
  await setImmediate();
  assert.equal(f.pending.has(1), false);
  await f.service.ssh.reject([...f.service.ssh.pending.values()][0]);
});

test('real SDK delivery rejects another SSH session as Busy before the first approval completes', async () => {
  const f = fixture();
  await f.service.ssh.registerSession(f.sessions.first);
  await f.service.ssh.registerSession(f.sessions.second);
  await f.deliver(1);
  await setImmediate();
  assert.equal(f.service.ssh.pending.size, 1);
  await f.deliver(2, 'second');
  await setImmediate();
  assert.equal(f.responses.length, 1);
  assert.equal(f.responses[0].id, 2);
  assert.equal(f.responses[0].error.code, -32006);
  assert.equal(f.service.ssh.pending.size, 1);
  assert.ok(f.pending.has(1));
  assert.equal(f.pending.has(2), false);
  await f.service.ssh.reject([...f.service.ssh.pending.values()][0]);
});

test('disabling the SDK queue preserves EVM/Solana pending requests and duplicate delivery does not duplicate approval', async () => {
  const f = fixture();
  let events = 0;
  f.client.events.on('session_request', () => events++);
  await f.deliver(1, 'wallet', 'eip155:1', 'personal_sign');
  await f.deliver(
    2,
    'wallet',
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    'solana_signMessage',
  );
  await f.deliver(1, 'wallet', 'eip155:1', 'personal_sign');
  assert.equal(events, 2);
  assert.deepEqual([...f.service.requests.keys()], [1, 2]);
  await f.service.rejectRequest(1);
  assert.deepEqual([...f.service.requests.keys()], [2]);
  assert.deepEqual([...f.pending.keys()], [2]);
  await f.service.rejectRequest(2);
  assert.equal(f.service.requests.size, 0);
  assert.equal(f.pending.size, 0);
});
