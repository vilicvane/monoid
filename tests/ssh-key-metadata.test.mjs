import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {
  SSH_EVENTS,
  SSH_METADATA_EVENT,
  SSH_METADATA_METHOD,
  SSH_METHODS,
  encodeBase64,
} from '@monoid/ssh-protocol';
import {ed25519} from '@noble/curves/ed25519';
import {observable, runInAction} from 'mobx';

import {buildWalletConnectNamespaces} from '../.bld/app/@lib/wallet-connect.js';
import {
  SSHKeyStore,
  getSSHKeyMetadata,
} from '../.bld/app/@services/ssh-key-store.js';
import {SSHWalletService} from '../.bld/app/@services/ssh-wallet-service.js';

const publicKey = value =>
  Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(value))).toString(
    'hex',
  );
const wallet = (value, alias) => ({
  type: 'ed25519',
  index: `05${String(value).padStart(18, '0')}`,
  alias,
  rawPublicKey: publicKey(value),
  wallets: [],
});
const seed = {
  type: 'seed',
  index: '021234567890abcdef00',
  alias: undefined,
  derivedKeys: [
    {
      derivation: {
        type: 'monoid-001',
        curve: 'ed25519',
        context: ' deploy\n生产 ',
      },
      publicKey: publicKey(3),
    },
  ],
  wallets: [],
};

test('SSH metadata method and invalidation event are approved only when negotiated', () => {
  const account = fixture().candidates()[0].account;
  const proposal = {
    params: {
      requiredNamespaces: {
        monoid: {
          chains: ['monoid:ssh'],
          methods: [...SSH_METHODS],
          events: [...SSH_EVENTS],
        },
      },
      optionalNamespaces: {},
    },
  };
  assert.deepEqual(buildWalletConnectNamespaces(proposal, [account]).monoid, {
    chains: ['monoid:ssh'],
    accounts: [account],
    methods: [...SSH_METHODS],
    events: [...SSH_EVENTS],
  });
  proposal.params.requiredNamespaces.monoid.methods = ['monoid_sshSign'];
  proposal.params.requiredNamespaces.monoid.events = ['accountsChanged'];
  const approved = buildWalletConnectNamespaces(proposal, [account]).monoid;
  assert.deepEqual(approved.methods, ['monoid_sshSign']);
  assert.deepEqual(approved.events, ['accountsChanged']);
});

function fixture() {
  const wallets = observable([
    wallet(1, 'Laptop'),
    wallet(2, 'Not authorized'),
    structuredClone(seed),
  ]);
  const store = new SSHKeyStore();
  const candidates = () => store.candidates(wallets);
  const sessions = {};
  const pending = [];
  const responses = [];
  const events = [];
  const writes = [];
  let nextId = 1;
  const storage = {
    async set(_key, value) {
      writes.push(structuredClone(value));
    },
  };
  const kit = {
    getActiveSessions: () => sessions,
    getPendingSessionRequests: () => pending,
    async respondSessionRequest(value) {
      responses.push(structuredClone(value));
      const index = pending.findIndex(
        request =>
          request.topic === value.topic && request.id === value.response.id,
      );
      if (index >= 0) pending.splice(index, 1);
    },
    async emitSessionEvent(value) {
      events.push(structuredClone(value));
    },
  };
  const service = new SSHWalletService(kit, storage, undefined, candidates);
  function session(accounts = [candidates()[0].account], topic = 'topic') {
    return (sessions[topic] = {
      topic,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      namespaces: {
        monoid: {
          chains: ['monoid:ssh'],
          methods: [...SSH_METHODS],
          events: [...SSH_EVENTS],
          accounts,
        },
      },
    });
  }
  function request(changes = {}, topic = 'topic') {
    const value = {
      id: nextId++,
      topic,
      params: {
        chainId: 'monoid:ssh',
        request: {
          method: SSH_METADATA_METHOD,
          expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
          params: {},
          ...changes,
        },
      },
    };
    pending.push(value);
    return value;
  }
  return {
    wallets,
    candidates,
    sessions,
    service,
    kit,
    storage,
    writes,
    events,
    responses,
    pending,
    session,
    request,
  };
}

test('metadata uses current Safe names and context, exposing only approved accounts without writes or signing', async () => {
  const f = fixture();
  const [native, , derived] = f.candidates();
  await f.service.registerSession(f.session([native.account, derived.account]));
  const writes = f.writes.length;
  const release = f.service.signingLock.acquire();
  await f.service.receive(f.request(), true);
  release();
  assert.deepEqual(f.responses[0].response.result, {
    keys: [
      {account: native.account, name: 'Laptop'},
      {account: derived.account, name: '12345678', context: ' deploy\n生产 '},
    ],
  });
  assert.equal(f.writes.length, writes);
  assert.equal(f.service.pending.size, 0);
  assert.deepEqual(f.writes.at(-1).ledger, {});
  assert.deepEqual(f.events[0], {
    topic: 'topic',
    chainId: 'monoid:ssh',
    event: {name: SSH_METADATA_EVENT, data: {}},
  });
});

test('native and seed metadata share alias-or-shortID rules; empty context is omitted without normalizing text', () => {
  const f = fixture();
  const key = f.candidates()[2];
  assert.deepEqual(
    getSSHKeyMetadata({
      ...key,
      alias: '',
      derivation: {...key.derivation, context: ''},
    }),
    {account: key.account, name: '12345678'},
  );
  assert.deepEqual(
    getSSHKeyMetadata({
      ...key,
      alias: '中文'.repeat(32),
      derivation: {...key.derivation, context: ' '},
    }),
    {account: key.account, name: '中文'.repeat(32), context: ' '},
  );
});

test('metadata validates exact method, chain, params and expiry before replying', async () => {
  const f = fixture();
  await f.service.registerSession(f.session());
  for (const [change, code] of [
    [{params: undefined}, -32602],
    [{params: null}, -32602],
    [{params: []}, -32602],
    [{params: {accounts: []}}, -32602],
    [{expiryTimestamp: undefined}, -32602],
    [{expiryTimestamp: 'tomorrow'}, -32602],
    [{expiryTimestamp: 0}, -32004],
    [{method: `${SSH_METADATA_METHOD}Other`}, -32601],
  ]) {
    await f.service.receive(f.request(change));
    assert.equal(f.responses.at(-1).response.error.code, code);
  }
  const wrongChain = f.request();
  wrongChain.params.chainId = 'eip155:1';
  await f.service.receive(wrongChain);
  assert.equal(f.responses.at(-1).response.error.code, -32602);
  assert.equal(f.service.pending.size, 0);
  assert.deepEqual(f.writes.at(-1).ledger, {});
});

test('missing local authority and unnegotiated or expired sessions do not return an empty successful snapshot', async () => {
  const f = fixture();
  const current = f.session();
  await f.service.receive(f.request());
  assert.equal(f.responses.at(-1).response.error.code, -32001);
  await f.service.registerSession(current);
  current.namespaces.monoid.methods = ['monoid_sshSign'];
  await f.service.receive(f.request());
  assert.equal(f.responses.at(-1).response.error.code, -32001);
  current.namespaces.monoid.methods = [...SSH_METHODS];
  current.expiry = 1;
  await f.service.receive(f.request());
  assert.equal(f.responses.at(-1).response.error.code, -32004);
});

test('metadata waits for neither signing admission nor card work and never consumes their slot', async () => {
  const f = fixture();
  await f.service.registerSession(f.session());
  const gate = Promise.withResolvers();
  const save = f.storage.set;
  f.storage.set = async (...args) => {
    await gate.promise;
    await save(...args);
  };
  const signing = f.request({
    method: 'monoid_sshSign',
    params: {
      account: f.candidates()[0].account,
      algorithm: 'ssh-ed25519',
      data: encodeBase64(new TextEncoder().encode('test')),
      expiresAt: Math.floor(Date.now() / 1000) + 90,
    },
  });
  const receiving = f.service.receive(signing);
  await Promise.resolve();
  const metadata = f.request();
  await f.service.receive(metadata);
  assert.equal(f.responses.at(-1).response.id, metadata.id);
  assert.ok(f.responses.at(-1).response.result.keys);
  assert.throws(() => f.service.signingLock.acquire(), {code: -32006});
  gate.resolve();
  await receiving;
  assert.equal(f.service.pending.size, 1);
  await f.service.reject([...f.service.pending.values()][0]);
});

test('registration and Switch ACK must be durable before metadata or invalidation events are exposed', async () => {
  const f = fixture();
  const current = f.session();
  const gate = Promise.withResolvers();
  const save = f.storage.set;
  f.storage.set = async (...args) => {
    await gate.promise;
    await save(...args);
  };
  const registering = f.service.registerSession(current);
  await f.service.receive(f.request());
  assert.equal(f.responses.at(-1).response.error.code, -32001);
  assert.equal(f.events.length, 0);
  gate.resolve();
  await registering;
  await setImmediate();
  assert.equal(f.events.length, 1);

  const other = f.candidates()[1].account;
  const revision = await f.service.beginSwitch('topic', [other]);
  current.namespaces.monoid.accounts = [other];
  await f.service.receive(f.request());
  assert.equal(f.responses.at(-1).response.error.code, -32001);
  const ack = Promise.withResolvers();
  f.storage.set = async (...args) => {
    await ack.promise;
    await save(...args);
  };
  const acknowledging = f.service.acknowledgeSwitch('topic', revision);
  await f.service.receive(f.request());
  assert.equal(f.responses.at(-1).response.error.code, -32001);
  assert.equal(f.events.length, 1);
  ack.resolve();
  await acknowledging;
  await f.service.receive(f.request());
  assert.deepEqual(f.responses.at(-1).response.result, {
    keys: [{account: other, name: 'Not authorized'}],
  });
  assert.equal(f.events.length, 2);
});

test('alias and candidate changes notify only sessions whose authorized snapshot changes', async () => {
  const f = fixture();
  await f.service.registerSession(f.session());
  await setImmediate();
  const baseline = f.events.length;
  runInAction(() => {
    f.wallets[1].alias = 'Private name';
  });
  await setImmediate();
  assert.equal(f.events.length, baseline);
  runInAction(() => {
    f.wallets[0].alias = 'Renamed';
  });
  await setImmediate();
  assert.equal(f.events.length, baseline + 1);
  assert.deepEqual(f.events.at(-1).event.data, {});
  await f.service.receive(f.request());
  assert.equal(f.responses.at(-1).response.result.keys[0].name, 'Renamed');
  runInAction(() => {
    f.wallets.splice(0, 1);
  });
  await setImmediate();
  assert.equal(f.events.length, baseline + 2);
  await f.service.receive(f.request());
  assert.deepEqual(f.responses.at(-1).response.result, {keys: []});
});

test('storage failure and invalidation fail metadata closed even while SDK still exposes the account', async () => {
  const f = fixture();
  await f.service.registerSession(f.session());
  await setImmediate();
  f.storage.set = async () => {
    throw new Error('Unavailable');
  };
  await assert.rejects(
    f.service.beginSwitch('topic', [f.candidates()[0].account]),
  );
  await f.service.receive(f.request());
  assert.equal(f.responses.at(-1).response.error.code, -32603);
  const baseline = f.events.length;
  f.service.notifyMetadataChanged();
  await setImmediate();
  assert.equal(f.events.length, baseline);

  const valid = fixture();
  await valid.service.registerSession(valid.session());
  const responding = valid.service.receive(valid.request());
  valid.service.invalidateSession('topic');
  await responding;
  assert.equal(valid.responses.at(-1).response.error.code, -32001);
});

test('concurrent rereads of one metadata request publish one response without entering the signing ledger', async () => {
  const f = fixture();
  await f.service.registerSession(f.session());
  const gate = Promise.withResolvers();
  const respond = f.kit.respondSessionRequest;
  f.kit.respondSessionRequest = async value => {
    await respond(value);
    await gate.promise;
  };
  const request = f.request();
  const first = f.service.receive(request);
  const second = f.service.receive(request);
  assert.equal(first, second);
  await setImmediate();
  assert.equal(f.responses.length, 1);
  gate.resolve();
  await first;
  assert.deepEqual(f.writes.at(-1).ledger, {});
});
