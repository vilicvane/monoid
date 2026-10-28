import assert from 'node:assert/strict';
import {test} from 'node:test';

import {autorun} from 'mobx';

import {CardBundleSession} from '../.bld/app/@components/views/safe/@card/card-bundle-session.js';
import {CardSecretPINSession} from '../.bld/app/@components/views/safe/@card/card-secret-pin-session.js';
import {CBORAppletError} from '../.bld/app/@lib/cbor-applet.js';

const PIN = 'Safe-42';
const bundle = new Uint8Array(32).fill(42);
const hex = value => Buffer.from(value).toString('hex');
const signal = () => new AbortController().signal;

function hello(identity, overrides = {}) {
  return {
    version: 1,
    id: Uint8Array.of(0, 0, 0, identity),
    publicKey: Uint8Array.from([4, ...new Array(64).fill(identity)]),
    bundle: false,
    authority: false,
    alias: false,
    allowPeerExtension: false,
    pins: {access: 5, secret: 5},
    ...overrides,
  };
}

function prepared(card) {
  return {
    id: hex(card.id),
    publicKey: hex(card.publicKey),
    alias: card.alias,
    allowPeerExtension: card.allowPeerExtension,
    authority: card.authority,
    bundle: card.bundle === false ? false : hex(card.bundle),
  };
}

function packet(members, recipient) {
  return Uint8Array.from([
    1,
    members.length >> 8,
    members.length & 255,
    ...members
      .map(card => card.publicKey)
      .sort(Buffer.compare)
      .flatMap(key => [...key]),
    ...new Array(113).fill(recipient.id[3]),
  ]);
}

function applet(card, members) {
  return {
    calls: [],
    async reset(request) {
      this.calls.push(['reset', structuredClone(request)]);
      await this.onReset?.();
      return {};
    },
    async hello(request) {
      this.calls.push(['hello', structuredClone(request)]);
      return {...card, bundle: false, pins: {access: false, secret: false}};
    },
    async authenticate(request) {
      this.calls.push(['authenticate', structuredClone(request)]);
      await this.onAuthenticate?.(request);
    },
    async createBundle(request) {
      this.calls.push(['createBundle', structuredClone(request)]);
      assert.equal(request.publicKeys.length, members.length - 1);
      assert.equal(
        request.publicKeys.some(key => hex(key) === hex(card.publicKey)),
        false,
      );
      const response = {
        bundle: bundle.slice(),
        data: request.publicKeys.map(key => {
          const member = members.find(
            member => hex(member.publicKey) === hex(key),
          );
          assert.ok(member);
          return packet(members, member);
        }),
      };
      await this.onCreate?.(response);
      return response;
    },
    async joinBundle(request) {
      this.calls.push(['joinBundle', structuredClone(request)]);
      const response = {bundle: bundle.slice()};
      await this.onJoin?.(response);
      return response;
    },
  };
}

async function ready(identities = [3, 1, 2]) {
  const members = identities.map(identity => hello(identity));
  const session = new CardBundleSession();
  for (const card of members) await session.addCard(card);
  await session.beginRoundTwo();
  return {
    session,
    members,
    applets: members.map(card => applet(card, members)),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return {promise, resolve};
}

test('a rejected PIN re-prompts before joining, while a lost join response is never replayed', async () => {
  const {session, members, applets} = await ready([1, 2]);
  await session.configureCard(applets[0], members[0], PIN, signal());
  const pins = new CardSecretPINSession();
  const card = prepared(members[1]);
  pins.onAuthenticated(card, PIN)();
  let prompts = 0;
  const run = () =>
    pins.run(
      [card],
      async (_card, _signal, message) => {
        prompts++;
        if (message) {
          assert.equal(message, 'Incorrect PIN, tries remaining: 4');
          assert.equal(applets[1].calls.length, 1);
          applets[1].onAuthenticate = undefined;
        }
        return PIN;
      },
      async (credentials, signal) => {
        session.validateCard(members[1]);
        const {pin, onAuthenticated} = credentials(card);
        await session.configureCard(
          applets[1],
          members[1],
          pin,
          signal,
          onAuthenticated,
        );
      },
    );
  const failure = new CBORAppletError({code: 'INVALID_PIN', tries: 4});
  applets[1].onAuthenticate = () => {
    throw failure;
  };
  applets[1].onJoin = () => {
    throw new Error('Lost response');
  };
  await assert.rejects(run(), /Lost response/);
  assert.equal(prompts, 1);
  applets[1].onJoin = undefined;
  await run();
  assert.equal(prompts, 1);
  assert.equal(session.phase, 'complete');
});

test('collection requires distinct initialized cards and freezes the selected membership', async () => {
  const session = new CardBundleSession();
  assert.equal(session.phase, 'collecting');
  await assert.rejects(session.beginRoundTwo(), /at least two/);
  await session.addCard(hello(1));
  await assert.rejects(
    session.addCard(hello(1, {id: Uint8Array.of(1, 2, 3, 4)})),
    /already added/,
  );
  await assert.rejects(session.beginRoundTwo(), /at least two/);
  await session.addCard(hello(2));
  await session.removeCard(hex(hello(1).publicKey));
  await session.addCard(hello(3));
  assert.deepEqual(
    session.cards.map(card => card.id),
    ['00000002', '00000003'],
  );
  await session.beginRoundTwo();
  await assert.rejects(session.addCard(hello(4)), /already confirmed/);
  await assert.rejects(
    session.removeCard(hex(hello(2).publicKey)),
    /already confirmed/,
  );
  await assert.rejects(session.beginRoundTwo(), /already confirmed/);
  assert.equal(session.busy, false);
});

test('a prepared Card snapshot seeds collection without a synthetic Hello or PIN state', async () => {
  const session = new CardBundleSession();
  const first = hello(10);
  const snapshot = prepared(first);
  await session.addPreparedCard({
    ...snapshot,
    id: snapshot.id.toUpperCase(),
    publicKey: snapshot.publicKey.toUpperCase(),
  });
  assert.deepEqual(session.cards, [
    {
      id: snapshot.id,
      publicKey: snapshot.publicKey,
      status: 'pending',
      alias: snapshot.alias,
      allowPeerExtension: snapshot.allowPeerExtension,
      authority: snapshot.authority,
    },
  ]);
  assert.equal(session.phase, 'collecting');
  assert.equal(session.configuredCount, 0);
  await assert.rejects(session.beginRoundTwo(), /at least two/);
  const second = hello(2);
  await session.addCard(second);
  await session.beginRoundTwo();
  const creator = applet(first, [first, second]);
  await session.configureCard(creator, first, PIN, signal());
  assert.equal(session.configuredCount, 1);
  assert.deepEqual(creator.calls[1], [
    'createBundle',
    {publicKeys: [second.publicKey]},
  ]);
});

test('prepared and scanned cards share duplicate and fixed-membership rules', async () => {
  const session = new CardBundleSession();
  await session.addPreparedCard(prepared(hello(1)));
  await assert.rejects(session.addCard(hello(1)), /already added/);
  await assert.rejects(
    session.addPreparedCard({...prepared(hello(1)), id: 'abcdef01'}),
    /already added/,
  );
  await session.addCard(hello(2));
  await assert.rejects(
    session.addPreparedCard(prepared(hello(2))),
    /already added/,
  );
  await session.beginRoundTwo();
  await assert.rejects(
    session.addPreparedCard(prepared(hello(3))),
    /already confirmed/,
  );
  assert.equal(session.cards.length, 2);
});

for (const [label, override, error] of [
  ['enrolled card', {bundle: hex(bundle)}, /already belongs/],
  ['short ID', {id: '123456'}, /Invalid card identity/],
  ['nonhex ID', {id: '1234567g'}, /Invalid card identity/],
  ['short public key', {publicKey: '04'.repeat(33)}, /Invalid card identity/],
  [
    'wrong public key prefix',
    {publicKey: '00'.repeat(65)},
    /Invalid card identity/,
  ],
  [
    'nonhex public key',
    {publicKey: `04${'0g'.repeat(64)}`},
    /Invalid card identity/,
  ],
  ['short bundle hash', {bundle: '01'.repeat(31)}, /Invalid card identity/],
  ['nonhex bundle hash', {bundle: '0g'.repeat(32)}, /Invalid card identity/],
]) {
  test(`prepared collection rejects ${label}`, async () => {
    const session = new CardBundleSession();
    await assert.rejects(
      session.addPreparedCard({...prepared(hello(1)), ...override}),
      error,
    );
    assert.equal(session.cards.length, 0);
    assert.equal(session.busy, false);
  });
}

test('prepared and scanned cards respect the total enrollment packet size limit', async () => {
  const session = new CardBundleSession();
  for (let identity = 1; identity <= 22; identity++) {
    await session.addPreparedCard(prepared(hello(identity)));
  }
  await assert.rejects(
    session.addPreparedCard(prepared(hello(23))),
    /Too many cards/,
  );
  await assert.rejects(session.addCard(hello(23)), /Too many cards/);
  assert.equal(session.cards.length, 22);
});

test('prepared cards still require live matching identity, Bundle and both PIN states in round two', async () => {
  const session = new CardBundleSession();
  const first = hello(1);
  const second = hello(2);
  await session.addPreparedCard(prepared(first));
  await session.addPreparedCard(prepared(second));
  await session.beginRoundTwo();
  const creator = applet(first, [first, second]);
  for (const current of [
    {...first, id: hello(3).id},
    {...first, publicKey: hello(3).publicKey},
    {...first, bundle},
    {...first, pins: {access: 5, secret: false}},
    {...first, pins: {access: false, secret: 5}},
    {...first, pins: {access: 5, secret: 0}},
    {...first, pins: {access: 0, secret: 5}},
  ]) {
    assert.throws(() => session.validateCard(current));
    await assert.rejects(
      session.configureCard(creator, current, PIN, signal()),
    );
  }
  assert.deepEqual(creator.calls, []);
  assert.equal(session.configuredCount, 0);
  assert.equal(session.generationUncertain, false);
  await session.configureCard(creator, first, PIN, signal());
  assert.equal(session.configuredCount, 1);
});

test('a reset card must complete PIN initialization before it can join collection', async () => {
  const session = new CardBundleSession();
  const card = hello(1, {pins: {access: false, secret: false}});
  await assert.rejects(session.addCard(card), /Set up the card first/);
  await assert.rejects(
    session.addCard({...card, pins: {access: false, secret: 5}}),
    /Set up the card first/,
  );
  assert.equal(session.cards.length, 0);
  await session.addCard({...card, pins: {access: 5, secret: 5}});
  assert.equal(session.cards.length, 1);
  assert.equal(session.cards[0].publicKey, hex(card.publicKey));
});

test('round two rejects a newly bundled creator or recipient without resetting or authenticating it', async () => {
  const {session, members, applets} = await ready([1, 2]);
  const otherBundle = new Uint8Array(32).fill(7);
  await assert.rejects(
    session.configureCard(
      applets[0],
      {...members[0], bundle: otherBundle},
      PIN,
      signal(),
    ),
    /another bundle/,
  );
  assert.deepEqual(applets[0].calls, []);
  assert.equal(session.generationUncertain, false);
  await session.configureCard(applets[0], members[0], PIN, signal());
  await assert.rejects(
    session.configureCard(
      applets[1],
      {...members[1], bundle: otherBundle},
      PIN,
      signal(),
    ),
    /another bundle/,
  );
  assert.deepEqual(applets[1].calls, []);
  await session.configureCard(applets[1], members[1], PIN, signal());
  assert.deepEqual(
    applets[1].calls.map(call => call[0]),
    ['authenticate', 'joinBundle'],
  );
  assert.equal(session.phase, 'complete');
});

test('Bundle cache state advances from a live unbundled observation to the acknowledged joined hash', async () => {
  const {session, members, applets} = await ready([1, 2]);
  await session.configureCard(applets[0], members[0], PIN, signal());
  assert.equal(session.cards[0].bundle, hex(bundle));
  applets[1].onJoin = () => {
    throw new Error('Response lost');
  };
  await assert.rejects(
    session.configureCard(applets[1], members[1], PIN, signal()),
    /Response lost/,
  );
  assert.equal(session.cards[1].bundle, false);
  assert.equal(session.cards[1].status, 'pending');
  applets[1].onJoin = undefined;
  await session.configureCard(
    applets[1],
    {...members[1], bundle},
    PIN,
    signal(),
  );
  assert.equal(session.cards[1].bundle, hex(bundle));
  assert.equal(session.phase, 'complete');
});

for (const [label, overrides, error] of [
  ['existing bundle', {bundle}, /already belongs/],
  ['unset Secret PIN', {pins: {access: 5, secret: false}}, /Set up/],
  ['unset Access PIN', {pins: {access: false, secret: 5}}, /Set up/],
  ['blocked Secret PIN', {pins: {access: 5, secret: 0}}, /Secret PIN blocked/],
  ['blocked Access PIN', {pins: {access: 0, secret: 5}}, /Access PIN blocked/],
  ['short ID', {id: new Uint8Array(3)}, /Invalid card identity/],
  [
    'compressed public key',
    {publicKey: new Uint8Array(33)},
    /Invalid card identity/,
  ],
  [
    'wrong public key prefix',
    {publicKey: new Uint8Array(65)},
    /Invalid card identity/,
  ],
  ['short bundle hash', {bundle: new Uint8Array(4)}, /Invalid card identity/],
]) {
  test(`collection rejects ${label}`, async () => {
    const session = new CardBundleSession();
    await assert.rejects(session.addCard(hello(1, overrides)), error);
    assert.equal(session.cards.length, 0);
    assert.equal(session.busy, false);
  });
}

test('any member can create, and recipients complete in any order without a return scan', async () => {
  const {session, members, applets} = await ready();
  const observed = [];
  const dispose = autorun(() =>
    observed.push([session.configuredCount, session.phase]),
  );
  try {
    await session.configureCard(applets[1], members[1], PIN, signal());
    assert.equal(session.bundle, hex(bundle));
    assert.deepEqual(session.creator, {
      id: '00000001',
      publicKey: hex(members[1].publicKey),
    });
    assert.equal(session.generationUncertain, false);
    assert.equal(session.configuredCount, 1);
    assert.deepEqual(applets[1].calls, [
      ['authenticate', {secret: true, pin: PIN}],
      [
        'createBundle',
        {publicKeys: [members[0].publicKey, members[2].publicKey]},
      ],
    ]);
    await session.configureCard(applets[2], members[2], PIN, signal());
    await session.configureCard(applets[0], members[0], PIN, signal());
    for (const index of [2, 0]) {
      assert.deepEqual(applets[index].calls, [
        ['authenticate', {secret: true, pin: PIN}],
        [
          'joinBundle',
          {
            publicKey: members[1].publicKey,
            data: packet(members, members[index]),
          },
        ],
      ]);
    }
    assert.equal(session.configuredCount, 3);
    assert.equal(session.phase, 'complete');
    assert.deepEqual(
      observed.filter(
        (value, index) => index === 0 || value[0] !== observed[index - 1][0],
      ),
      [
        [0, 'configuring'],
        [1, 'configuring'],
        [2, 'configuring'],
        [3, 'complete'],
      ],
    );
    await assert.rejects(
      session.configureCard(applets[0], members[0], PIN, signal()),
      /setup complete/,
    );
  } finally {
    dispose();
  }
});

test('full identity and current card state are checked before any credentials are sent', async () => {
  const {session, members, applets} = await ready();
  for (const card of [
    hello(8, {id: members[0].id}),
    {...members[0], id: Uint8Array.of(4, 3, 2, 1)},
    {...members[0], bundle},
    {...members[0], pins: {access: 5, secret: false}},
  ]) {
    assert.throws(() => session.validateCard(card));
    await assert.rejects(
      session.configureCard(applets[0], card, PIN, signal()),
    );
  }
  await assert.rejects(
    session.configureCard(applets[0], members[0], 'short', signal()),
    /Secret PIN must/,
  );
  assert.deepEqual(applets[0].calls, []);
  assert.equal(session.creator, undefined);
  assert.equal(session.generationUncertain, false);
});

test('Secret authentication failures do not lock creation or use Access authentication', async () => {
  const {session, members, applets} = await ready();
  for (const tries of [4, 0]) {
    applets[0].onAuthenticate = () => {
      throw new CBORAppletError({code: 'INVALID_PIN', tries});
    };
    await assert.rejects(
      session.configureCard(applets[0], members[0], PIN, signal()),
      tries ? /Incorrect PIN.*4/ : /Secret PIN blocked/,
    );
    assert.equal(session.generationUncertain, false);
    assert.equal(session.creator, undefined);
  }
  assert.deepEqual(applets[0].calls, [
    ['authenticate', {secret: true, pin: PIN}],
    ['authenticate', {secret: true, pin: PIN}],
  ]);
  applets[0].onAuthenticate = undefined;
  await session.configureCard(applets[0], members[0], PIN, signal());
  assert.equal(session.configuredCount, 1);
});

test('cancellation before or during authentication never starts creation', async () => {
  const {session, members, applets} = await ready();
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    session.configureCard(applets[0], members[0], PIN, before.signal),
    {code: 'CANCELLED'},
  );
  assert.deepEqual(applets[0].calls, []);
  const during = new AbortController();
  applets[0].onAuthenticate = () => during.abort();
  await assert.rejects(
    session.configureCard(applets[0], members[0], PIN, during.signal),
    {code: 'CANCELLED'},
  );
  assert.deepEqual(
    applets[0].calls.map(call => call[0]),
    ['authenticate'],
  );
  assert.equal(session.generationUncertain, false);
  assert.equal(session.configuredCount, 0);
});

test('in-flight creation blocks other operations and advances only after an acknowledged response', async () => {
  const {session, members, applets} = await ready();
  const entered = deferred();
  const finish = deferred();
  applets[0].onCreate = async () => {
    entered.resolve();
    await finish.promise;
  };
  const creating = session.configureCard(applets[0], members[0], PIN, signal());
  await entered.promise;
  assert.equal(session.busy, true);
  assert.equal(session.generationUncertain, true);
  assert.equal(session.configuredCount, 0);
  await assert.rejects(
    session.configureCard(applets[1], members[1], PIN, signal()),
    /already in progress/,
  );
  await assert.rejects(
    session.removeCard(hex(members[0].publicKey)),
    /already in progress/,
  );
  assert.deepEqual(applets[1].calls, []);
  finish.resolve();
  await creating;
  assert.equal(session.configuredCount, 1);
  assert.equal(session.busy, false);
});

for (const [label, modify] of [
  [
    'lost response',
    () => {
      throw new Error('NFC disconnected');
    },
  ],
  [
    'short hash',
    response => {
      response.bundle = new Uint8Array(31);
    },
  ],
  [
    'missing packet',
    response => {
      response.data.pop();
    },
  ],
  [
    'wrong roster',
    response => {
      response.data[0][4] ^= 1;
    },
  ],
  [
    'short packet',
    response => {
      response.data[0] = response.data[0].slice(1);
    },
  ],
  [
    'wrong version',
    response => {
      response.data[0][0] = 2;
    },
  ],
  [
    'wrong member count',
    response => {
      response.data[0][2] = 2;
    },
  ],
]) {
  test(`${label} leaves creation uncertain and never permits a replay`, async () => {
    const {session, members, applets} = await ready();
    applets[0].onCreate = modify;
    await assert.rejects(
      session.configureCard(applets[0], members[0], PIN, signal()),
      /Bundle creation not confirmed/,
    );
    assert.equal(session.generationUncertain, true);
    assert.equal(session.bundle, undefined);
    assert.equal(session.configuredCount, 0);
    assert.equal(session.busy, false);
    assert.equal(session.creator.publicKey, hex(members[0].publicKey));
    for (const index of [0, 1]) {
      assert.throws(
        () => session.validateCard(members[index]),
        /Bundle creation not confirmed/,
      );
      await assert.rejects(
        session.configureCard(applets[index], members[index], PIN, signal()),
        /Bundle creation not confirmed/,
      );
    }
    assert.deepEqual(
      applets[0].calls.map(call => call[0]),
      ['authenticate', 'createBundle'],
    );
    assert.deepEqual(applets[1].calls, []);
  });
}

test('a creation acknowledged after cancellation retains its packets and confirmed progress', async () => {
  const {session, members, applets} = await ready([1, 2]);
  const controller = new AbortController();
  applets[0].onCreate = () => controller.abort();
  await assert.rejects(
    session.configureCard(applets[0], members[0], PIN, controller.signal),
    {code: 'CANCELLED'},
  );
  assert.equal(session.bundle, hex(bundle));
  assert.equal(session.generationUncertain, false);
  assert.equal(session.configuredCount, 1);
  await session.configureCard(applets[1], members[1], PIN, signal());
  assert.equal(session.phase, 'complete');
});

test('lost join acknowledgement can retry the identical packet after Hello reports the expected bundle', async () => {
  const {session, members, applets} = await ready([1, 2]);
  await session.configureCard(applets[0], members[0], PIN, signal());
  applets[1].onJoin = () => {
    throw new Error('NFC disconnected');
  };
  await assert.rejects(
    session.configureCard(applets[1], members[1], PIN, signal()),
    /NFC disconnected/,
  );
  assert.equal(session.configuredCount, 1);
  assert.equal(session.generationUncertain, false);
  assert.throws(
    () =>
      session.validateCard({...members[1], bundle: new Uint8Array(32).fill(1)}),
    /another bundle/,
  );
  applets[1].onJoin = undefined;
  await session.configureCard(
    applets[1],
    {...members[1], bundle},
    PIN,
    signal(),
  );
  const imports = applets[1].calls.filter(call => call[0] === 'joinBundle');
  assert.deepEqual(imports[0], imports[1]);
  assert.equal(session.phase, 'complete');
  assert.deepEqual(
    applets[0].calls.map(call => call[0]),
    ['authenticate', 'createBundle'],
  );
});

test('join compares the full hash and rejects completed cards before authentication', async () => {
  const {session, members, applets} = await ready();
  await session.configureCard(applets[0], members[0], PIN, signal());
  await assert.rejects(
    session.configureCard(applets[0], {...members[0], bundle}, PIN, signal()),
    /already configured/,
  );
  applets[1].onJoin = response => {
    response.bundle[31] ^= 1;
  };
  await assert.rejects(
    session.configureCard(applets[1], members[1], PIN, signal()),
    /different bundle/,
  );
  assert.equal(session.configuredCount, 1);
  assert.equal(session.cards[1].status, 'pending');
  assert.deepEqual(
    applets[0].calls.map(call => call[0]),
    ['authenticate', 'createBundle'],
  );
});

test('join acknowledgement remains committed when cancellation arrives during the APDU', async () => {
  const {session, members, applets} = await ready([1, 2]);
  await session.configureCard(applets[0], members[0], PIN, signal());
  const controller = new AbortController();
  applets[1].onJoin = () => controller.abort();
  await assert.rejects(
    session.configureCard(applets[1], members[1], PIN, controller.signal),
    {code: 'CANCELLED'},
  );
  assert.equal(session.configuredCount, 2);
  assert.equal(session.phase, 'complete');
  assert.equal(session.busy, false);
});
