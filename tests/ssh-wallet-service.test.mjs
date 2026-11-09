import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  createSSHAccount,
  encodeBase64,
  encodeSSHSignature,
  requestDigest,
} from '@monoid/ssh-protocol';
import {ed25519} from '@noble/curves/ed25519';

import {SSHWalletService} from '../.bld/app/@services/ssh-wallet-service.js';

const secret = new Uint8Array(32).fill(7);
const account = createSSHAccount('ed25519', ed25519.getPublicKey(secret));
const otherAccount = createSSHAccount(
  'ed25519',
  ed25519.getPublicKey(new Uint8Array(32).fill(8)),
);
const data = new TextEncoder().encode('SSH test data');
const signed = () =>
  encodeBase64(encodeSSHSignature('ssh-ed25519', ed25519.sign(data, secret)));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return {promise, resolve, reject};
};

function setup() {
  const sessions = {};
  const requests = [];
  const responses = [];
  const extensions = [];
  const snapshots = [];
  let stored;
  const storage = {
    async get() {
      return structuredClone(stored);
    },
    async set(_key, value) {
      stored = structuredClone(value);
      snapshots.push(stored);
    },
  };
  const kit = {
    getActiveSessions: () => sessions,
    getPendingSessionRequests: () => requests,
    async respondSessionRequest(response) {
      responses.push(structuredClone(response));
      const index = requests.findIndex(
        request =>
          request.topic === response.topic &&
          request.id === response.response.id,
      );
      if (index >= 0) requests.splice(index, 1);
    },
    async extendSession({topic}) {
      extensions.push(topic);
      return {acknowledged: async () => {}};
    },
  };
  const service = new SSHWalletService(kit, storage);
  async function session(topic = 'topic') {
    const value = {
      topic,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      namespaces: {
        monoid: {
          chains: ['monoid:ssh'],
          accounts: [account],
          methods: ['monoid_sshSign'],
          events: ['accountsChanged'],
        },
      },
    };
    sessions[topic] = value;
    await service.registerSession(value);
    return value;
  }
  function request(id = 1, topic = 'topic', changes = {}) {
    const value = {
      topic,
      id,
      params: {
        chainId: 'monoid:ssh',
        request: {
          method: 'monoid_sshSign',
          expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
          params: {
            account,
            algorithm: 'ssh-ed25519',
            data: encodeBase64(data),
            expiresAt: Math.floor(Date.now() / 1000) + 90,
            ...changes,
          },
        },
      },
    };
    requests.push(value);
    return value;
  }
  return {
    service,
    storage,
    kit,
    sessions,
    requests,
    responses,
    extensions,
    snapshots,
    session,
    request,
  };
}

test('SSH admission is durable before any interactive request becomes visible', async () => {
  const f = setup();
  await f.session();
  const save = deferred();
  const original = f.storage.set;
  f.storage.set = async (...args) => {
    await save.promise;
    await original(...args);
  };
  const receive = f.service.receive(f.request());
  await Promise.resolve();
  assert.equal(f.service.pending.size, 0);
  save.resolve();
  await receive;
  assert.equal(f.service.pending.size, 1);
  assert.equal(Object.values(f.snapshots.at(-1).ledger)[0].state, 'pending');
  await f.service.reject([...f.service.pending.values()][0]);
});

test('same request never prompts or signs twice and terminal persists before response', async () => {
  const f = setup();
  await f.session();
  const request = f.request();
  await f.service.receive(request);
  const value = [...f.service.pending.values()][0];
  await f.service.receive(structuredClone(request));
  assert.equal(f.service.pending.size, 1);
  let count = 0;
  const respond = f.kit.respondSessionRequest;
  f.kit.respondSessionRequest = async response => {
    assert.equal(Object.values(f.snapshots.at(-1).ledger)[0].state, 'terminal');
    await respond(response);
  };
  await f.service.sign(value, async check => {
    check();
    count++;
    return signed();
  });
  assert.equal(count, 1);
  assert.ok(f.responses[0].response.result.signature);
  await f.service.receive(request);
  assert.equal(f.service.pending.size, 0);
  assert.equal(f.responses.at(-1).response.error.code, -32007);
  assert.deepEqual(f.extensions, ['topic']);
});

test('SSH renewal waits for signature publication without blocking subsequent signing', async () => {
  const f = setup();
  await f.session();
  const publishing = deferred();
  const published = deferred();
  const peer = deferred();
  const respond = f.kit.respondSessionRequest;
  f.kit.respondSessionRequest = async response => {
    publishing.resolve();
    await published.promise;
    await respond(response);
  };
  const extend = f.kit.extendSession;
  f.kit.extendSession = async options => {
    await extend(options);
    return {acknowledged: () => peer.promise};
  };
  const sign = async id => {
    await f.service.receive(f.request(id));
    await f.service.sign([...f.service.pending.values()][0], async () =>
      signed(),
    );
  };
  const first = sign(1);
  await publishing.promise;
  assert.deepEqual(f.extensions, []);
  published.resolve();
  await first;
  await sign(2);
  assert.deepEqual(f.extensions, ['topic']);
  assert.ok(f.responses.every(({response}) => response.result.signature));

  // A lost confirmation releases the renewal slot for a later signature.
  peer.reject(new Error('Renewal not acknowledged'));
  await assert.rejects(peer.promise);
  f.kit.extendSession = extend;
  const confirmed = deferred();
  f.service.onSessionExtended = confirmed.resolve;
  await sign(3);
  await confirmed.promise;
  assert.deepEqual(f.extensions, ['topic', 'topic']);
});

test('SSH signature publication failure does not extend the session', async () => {
  const f = setup();
  await f.session();
  await f.service.receive(f.request());
  f.kit.respondSessionRequest = async () => {
    throw new Error('Relay disconnected');
  };
  await assert.rejects(
    f.service.sign([...f.service.pending.values()][0], async () => signed()),
  );
  assert.deepEqual(f.extensions, []);
});

test('SSH does not extend an authorization revoked during signature publication', async () => {
  const f = setup();
  await f.session();
  await f.service.receive(f.request());
  const respond = f.kit.respondSessionRequest;
  f.kit.respondSessionRequest = async response => {
    await respond(response);
    f.service.invalidateSession(response.topic);
  };
  await f.service.sign([...f.service.pending.values()][0], async () =>
    signed(),
  );
  assert.ok(f.responses[0].response.result.signature);
  assert.deepEqual(f.extensions, []);
});

test('one global approval slot rejects another session with durable Busy', async () => {
  const f = setup();
  await f.session();
  await f.session('other');
  await f.service.receive(f.request());
  await f.service.receive(f.request(2, 'other'));
  assert.equal(f.responses[0].response.error.code, -32006);
  assert.equal(f.service.pending.size, 1);
  assert.equal(
    f.snapshots.at(-1).ledger[JSON.stringify(['other', 2])].state,
    'terminal',
  );
  await f.service.reject([...f.service.pending.values()][0]);
});

test('changed payload under the same id invalidates the original approval', async () => {
  const f = setup();
  await f.session();
  const request = f.request();
  await f.service.receive(request);
  const value = [...f.service.pending.values()][0];
  const changed = structuredClone(request);
  changed.params.request.params.data = encodeBase64(new Uint8Array([3]));
  await f.service.receive(changed);
  assert.equal(f.responses[0].response.error.code, -32602);
  assert.throws(() => f.service.assertPending(value));
});

test('storage failure prevents approval and card work', async () => {
  const f = setup();
  await f.session();
  f.storage.set = async () => {
    throw new Error('disk unavailable');
  };
  await f.service.receive(f.request());
  assert.equal(f.service.pending.size, 0);
  assert.equal(f.responses[0].response.error.code, -32603);
});

test('a recovered pending ledger entry is interrupted, never resumed as another card operation', async () => {
  const f = setup();
  await f.session();
  const request = f.request();
  const params = request.params.request.params;
  const stored = structuredClone(f.snapshots.at(-1));
  stored.ledger[JSON.stringify(['topic', 1])] = {
    topic: 'topic',
    id: 1,
    digest: requestDigest(params),
    expiresAt: params.expiresAt,
    wcExpiry: request.params.request.expiryTimestamp,
    state: 'pending',
  };
  const restored = new SSHWalletService(f.kit, f.storage, stored);
  await restored.receive(request);
  assert.equal(restored.pending.size, 0);
  assert.equal(f.responses[0].response.error.code, -32007);
  assert.equal(Object.values(f.snapshots.at(-1).ledger)[0].state, 'terminal');
});

test('terminal persistence failure cannot release a completed signature', async () => {
  const f = setup();
  await f.session();
  await f.service.receive(f.request());
  const value = [...f.service.pending.values()][0];
  f.storage.set = async () => {
    throw new Error('disk unavailable');
  };
  await assert.rejects(f.service.sign(value, async () => signed()));
  assert.equal(f.responses.length, 0);
  assert.equal(f.service.pending.size, 0);
});

test('Switch revocation survives SDK rollback and re-adding a key cannot revive an old operation', async () => {
  const f = setup();
  const session = await f.session();
  await f.service.receive(f.request());
  const value = [...f.service.pending.values()][0];
  const card = deferred();
  const signing = f.service.sign(value, async () => {
    await card.promise;
    return signed();
  });
  await f.service.beginSwitch('topic', [otherAccount]);
  assert.deepEqual(f.service.getDesiredAccounts('topic'), [otherAccount]);
  assert.deepEqual(session.namespaces.monoid.accounts, [account]);
  await f.service.receive(f.request(2));
  assert.equal(f.responses.at(-1).response.error.code, -32001);
  const revision = await f.service.beginSwitch('topic', [account]);
  await f.service.acknowledgeSwitch('topic', revision);
  card.resolve();
  await assert.rejects(signing);
  assert.ok(f.responses.every(response => !response.response.result));
  assert.throws(() => f.service.assertPending(value));
});

test('new accounts cannot sign before Switch acknowledgment', async () => {
  const f = setup();
  const session = await f.session();
  const revision = await f.service.beginSwitch('topic', [otherAccount]);
  session.namespaces.monoid.accounts = [otherAccount];
  await f.service.receive(f.request(1, 'topic', {account: otherAccount}));
  assert.equal(f.responses[0].response.error.code, -32001);
  await f.service.acknowledgeSwitch('topic', revision);
  await f.service.receive(f.request(2, 'topic', {account: otherAccount}));
  assert.equal(f.service.pending.size, 1);
  await f.service.reject([...f.service.pending.values()][0]);
});

test('revocation while terminal state is being saved blocks the signature commit', async () => {
  const f = setup();
  await f.session();
  await f.service.receive(f.request());
  const value = [...f.service.pending.values()][0];
  const saving = deferred();
  const original = f.storage.set;
  let block = true;
  f.storage.set = async (...args) => {
    if (block) {
      block = false;
      await saving.promise;
    }
    await original(...args);
  };
  const signing = f.service.sign(value, async () => signed());
  await Promise.resolve();
  await Promise.resolve();
  const switching = f.service.beginSwitch('topic', [otherAccount]);
  saving.resolve();
  await Promise.all([assert.rejects(signing), switching]);
  assert.ok(f.responses.every(response => !response.response.result));
});

test('SSH and ordinary wallet signing share a synchronous slot, including before the prompt is persisted', async () => {
  const f = setup();
  await f.session();
  const releaseWallet = f.service.signingLock.acquire();
  await f.service.receive(f.request());
  assert.equal(f.responses[0].response.error.code, -32006);
  assert.equal(f.service.pending.size, 0);
  releaseWallet();

  const save = deferred();
  const original = f.storage.set;
  f.storage.set = async (...args) => {
    await save.promise;
    await original(...args);
  };
  const receiving = f.service.receive(f.request(2));
  await Promise.resolve();
  assert.equal(f.service.pending.size, 0);
  assert.throws(
    () => f.service.signingLock.acquire(),
    error => error.code === -32006,
  );
  save.resolve();
  await receiving;
  await f.service.reject([...f.service.pending.values()][0]);
  f.service.signingLock.acquire()();
});

test('cancelling SSH does not release the shared signer until in-flight card work settles', async () => {
  const f = setup();
  await f.session();
  await f.service.receive(f.request());
  const value = [...f.service.pending.values()][0];
  const card = deferred();
  const signing = f.service.sign(value, async () => {
    await card.promise;
    return signed();
  });
  await f.service.cancel(value);
  assert.equal(f.service.pending.size, 0);
  assert.throws(
    () => f.service.signingLock.acquire(),
    error => error.code === -32006,
  );
  card.resolve();
  await assert.rejects(signing, error => error.code === -32007);
  f.service.signingLock.acquire()();
});

test('failed SSH admission storage releases the shared signer without permitting card work', async () => {
  const f = setup();
  await f.session();
  f.storage.set = async () => {
    throw new Error('Disk unavailable');
  };
  await f.service.receive(f.request());
  assert.equal(f.service.pending.size, 0);
  assert.equal(f.responses[0].response.error.code, -32603);
  f.service.signingLock.acquire()();
});
