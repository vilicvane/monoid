import assert from 'node:assert/strict';
import {test} from 'node:test';

import {reaction} from 'mobx';

import {CardBundleExtensionSession} from '../.bld/app/@components/views/safe/@card/card-bundle-extension-session.js';
import {CardSecretPINSession} from '../.bld/app/@components/views/safe/@card/card-secret-pin-session.js';
import {CBORAppletError} from '../.bld/app/@lib/cbor-applet.js';

const PIN = 'Secret-42';
const bundle = new Uint8Array(32).fill(42);
const requestData = Uint8Array.of(1, 42, 0, 17, 255);
const enrollmentData = Uint8Array.of(1, 0, 3, 255, 0, 42);
const hex = bytes => Buffer.from(bytes).toString('hex');
const signal = () => new AbortController().signal;

function hello(identity, overrides = {}) {
  return {
    version: 1,
    id: Uint8Array.of(0, 0, 0, identity),
    publicKey: Uint8Array.from([4, ...new Array(64).fill(identity)]),
    bundle: bundle.slice(),
    pins: {access: 5, secret: 5},
    ...overrides,
  };
}

function prepared(card) {
  return {
    id: hex(card.id),
    publicKey: hex(card.publicKey),
    bundle: card.bundle === false ? false : hex(card.bundle),
  };
}

function applet(card) {
  return {
    calls: [],
    async authenticate(request) {
      this.calls.push(['authenticate', structuredClone(request)]);
      await this.onAuthenticate?.();
      return {};
    },
    async extendBundle(request) {
      this.calls.push(['extendBundle', structuredClone(request)]);
      const response = {data: requestData.slice()};
      await this.onExtend?.(response, request);
      return response;
    },
    async approveBundleExtension(request) {
      this.calls.push(['approveBundleExtension', structuredClone(request)]);
      const response = {
        publicKey: card.publicKey.slice(),
        data: enrollmentData.slice(),
      };
      await this.onApprove?.(response, request);
      return response;
    },
    async joinBundle(request) {
      this.calls.push(['joinBundle', structuredClone(request)]);
      const response = {bundle: bundle.slice()};
      await this.onJoin?.(response, request);
      return response;
    },
  };
}

async function ready(phase = 'requesting') {
  const source = hello(1);
  const approver = hello(2);
  const target = hello(3, {bundle: false});
  const session = new CardBundleExtensionSession(prepared(source));
  const sourceApplet = applet(source);
  const approverApplet = applet(approver);
  const targetApplet = applet(target);
  if (phase !== 'collecting') await session.addCard(target);
  if (phase === 'approving' || phase === 'joining' || phase === 'complete') {
    await session.configureCard(sourceApplet, source, PIN, signal());
  }
  if (phase === 'joining' || phase === 'complete') {
    await session.configureCard(approverApplet, approver, PIN, signal());
  }
  if (phase === 'complete') {
    await session.configureCard(targetApplet, target, PIN, signal());
  }
  return {
    session,
    source,
    approver,
    target,
    sourceApplet,
    approverApplet,
    targetApplet,
  };
}

test('entry requires a full identity in an existing Bundle', () => {
  const source = prepared(hello(1));
  for (const override of [
    {id: 'abcd'},
    {id: '0000000g'},
    {publicKey: '04'.repeat(33)},
    {publicKey: '00'.repeat(65)},
    {bundle: '42'.repeat(31)},
    {bundle: 'zz'.repeat(32)},
  ]) {
    assert.throws(
      () => new CardBundleExtensionSession({...source, ...override}),
      /Invalid card identity/,
    );
  }
  assert.throws(
    () => new CardBundleExtensionSession({...source, bundle: false}),
    /does not belong/,
  );
  const session = new CardBundleExtensionSession({
    ...source,
    id: source.id.toUpperCase(),
    publicKey: source.publicKey.toUpperCase(),
    bundle: source.bundle.toUpperCase(),
  });
  assert.deepEqual(session.source, {
    id: source.id,
    publicKey: source.publicKey,
  });
  assert.equal(session.bundle, source.bundle);
  assert.equal(session.phase, 'collecting');
});

test('a newly initialized target joins with its page PIN and wrong-card validation never consumes it', async () => {
  const {session, target, targetApplet, source} = await ready('joining');
  const pins = new CardSecretPINSession();
  const card = prepared(target);
  pins.onAuthenticated(card, PIN)();
  let prompts = 0;
  let current = source;
  const run = () =>
    pins.run(
      [card],
      async () => {
        prompts++;
        return PIN;
      },
      async (credentials, signal) => {
        session.validateCard(current);
        const {pin, onAuthenticated} = credentials(prepared(current));
        await session.configureCard(
          targetApplet,
          current,
          pin,
          signal,
          onAuthenticated,
        );
      },
    );
  await assert.rejects(run(), /Wrong card/);
  assert.deepEqual(targetApplet.calls, []);
  current = target;
  await run();
  assert.equal(prompts, 0);
  assert.deepEqual(targetApplet.calls[0], [
    'authenticate',
    {secret: true, pin: PIN},
  ]);
  assert.equal(session.phase, 'complete');
});

test('extension keeps the original PIN failure cause and acknowledges only successful Secret authentication', async () => {
  const {session, source, sourceApplet} = await ready();
  let authenticated = 0;
  const failure = new CBORAppletError({code: 'INVALID_PIN', tries: 4});
  sourceApplet.onAuthenticate = () => {
    throw failure;
  };
  await assert.rejects(
    session.configureCard(
      sourceApplet,
      source,
      PIN,
      signal(),
      () => authenticated++,
    ),
    error => error.cause === failure,
  );
  assert.equal(authenticated, 0);
  sourceApplet.onAuthenticate = undefined;
  sourceApplet.onExtend = () => {
    throw new Error('Lost response');
  };
  await assert.rejects(
    session.configureCard(
      sourceApplet,
      source,
      PIN,
      signal(),
      () => authenticated++,
    ),
    /Lost response/,
  );
  assert.equal(authenticated, 1);
  assert.equal(session.phase, 'requesting');
});

test('only one initialized new card is added and it remains editable until the requester acknowledges', async () => {
  const {session, source, target, sourceApplet} = await ready('collecting');
  await assert.rejects(session.addCard(source), /Scan a new card/);
  await assert.rejects(session.addCard(hello(2)), /already belongs/);
  const uninitialized = {
    ...target,
    pins: {access: false, secret: false},
  };
  assert.doesNotThrow(() => session.validateAddition(uninitialized));
  await assert.rejects(session.addCard(uninitialized), /Set up/);
  const otherBundle = {...target, bundle: new Uint8Array(32).fill(9)};
  assert.doesNotThrow(() => session.validateAddition(otherBundle));
  await assert.rejects(session.addCard(otherBundle), /already belongs/);
  assert.throws(() => session.validateAddition(hello(2)), /already belongs/);
  await session.addCard(target);
  assert.equal(session.phase, 'requesting');
  await session.addCard(target);
  await assert.rejects(
    session.addCard(hello(4, {bundle: false})),
    /Wrong card/,
  );
  await session.removeTarget();
  assert.equal(session.phase, 'collecting');
  assert.equal(session.target, undefined);
  const snapshot = prepared(target);
  await session.addPreparedCard(snapshot);
  await session.addPreparedCard(snapshot);
  assert.deepEqual(session.target, {
    id: snapshot.id,
    publicKey: snapshot.publicKey,
  });
  await session.configureCard(sourceApplet, source, PIN, signal());
  await assert.rejects(session.removeTarget(), /already confirmed/);
  await assert.rejects(session.addCard(target), /already confirmed/);
  await assert.rejects(session.addPreparedCard(snapshot), /already confirmed/);
});

test('prepared maintenance returns obey the same identity and membership rules', async () => {
  const {session, source, target} = await ready('collecting');
  await assert.rejects(
    session.addPreparedCard(prepared(source)),
    /Scan a new card/,
  );
  await assert.rejects(
    session.addPreparedCard(prepared(hello(2))),
    /already belongs/,
  );
  await session.addPreparedCard(prepared(target));
  await assert.rejects(
    session.addPreparedCard({...prepared(target), id: '00000004'}),
    /Wrong card/,
  );
  await assert.rejects(
    session.addPreparedCard({...prepared(target), publicKey: '00'.repeat(65)}),
    /Invalid card identity/,
  );
});

test('the three taps authenticate separately and forward both opaque packets without changes', async () => {
  const {
    session,
    source,
    approver,
    target,
    sourceApplet,
    approverApplet,
    targetApplet,
  } = await ready();
  const phases = [];
  const dispose = reaction(
    () => session.phase,
    phase => phases.push(phase),
    {fireImmediately: true},
  );
  try {
    await session.configureCard(sourceApplet, source, PIN, signal());
    await session.configureCard(approverApplet, approver, 'Secret-B', signal());
    await session.configureCard(targetApplet, target, 'Secret-C', signal());
    assert.deepEqual(phases, [
      'requesting',
      'approving',
      'joining',
      'complete',
    ]);
    assert.deepEqual(sourceApplet.calls, [
      ['authenticate', {secret: true, pin: PIN}],
      ['extendBundle', {publicKey: target.publicKey}],
    ]);
    assert.deepEqual(approverApplet.calls, [
      ['authenticate', {secret: true, pin: 'Secret-B'}],
      ['approveBundleExtension', {data: requestData}],
    ]);
    assert.deepEqual(targetApplet.calls, [
      ['authenticate', {secret: true, pin: 'Secret-C'}],
      ['joinBundle', {publicKey: approver.publicKey, data: enrollmentData}],
    ]);
    assert.deepEqual(session.approver, {
      id: hex(approver.id),
      publicKey: hex(approver.publicKey),
    });
    assert.deepEqual(session.requester, {
      id: hex(source.id),
      publicKey: hex(source.publicKey),
    });
    assert.equal(session.bundle, hex(bundle));
    assert.equal(session.busy, false);
  } finally {
    dispose();
  }
});

test('any existing member may request and the entry card may approve', async () => {
  const {
    session,
    source,
    approver: requester,
    target,
    sourceApplet,
    approverApplet: requesterApplet,
    targetApplet,
  } = await ready();
  assert.equal(session.requester, undefined);
  assert.doesNotThrow(() => session.validateCard(requester));
  assert.equal(session.requester, undefined);
  await session.configureCard(requesterApplet, requester, PIN, signal());
  assert.deepEqual(session.requester, {
    id: hex(requester.id),
    publicKey: hex(requester.publicKey),
  });
  assert.deepEqual(session.source, {
    id: hex(source.id),
    publicKey: hex(source.publicKey),
  });
  for (const card of [requester, {...requester, id: source.id}]) {
    await assert.rejects(
      session.configureCard(requesterApplet, card, PIN, signal()),
      /another bundle card/,
    );
  }
  assert.equal(requesterApplet.calls.length, 2);
  await session.configureCard(sourceApplet, source, PIN, signal());
  await session.configureCard(targetApplet, target, PIN, signal());
  assert.deepEqual(sourceApplet.calls[1], [
    'approveBundleExtension',
    {data: requestData},
  ]);
  assert.deepEqual(targetApplet.calls[1], [
    'joinBundle',
    {publicKey: source.publicKey, data: enrollmentData},
  ]);
  assert.equal(session.phase, 'complete');
});

test('the target and other Bundles are rejected before requester credentials', async () => {
  const {session, source, target, sourceApplet} = await ready();
  for (const card of [
    target,
    {...target, bundle: bundle.slice()},
    {...source, bundle: false},
    {...source, bundle: new Uint8Array(32).fill(9)},
    {...source, bundle: new Uint8Array(31)},
  ]) {
    assert.throws(() => session.validateCard(card));
    await assert.rejects(
      session.configureCard(sourceApplet, card, PIN, signal()),
    );
  }
  assert.deepEqual(sourceApplet.calls, []);
  assert.equal(session.phase, 'requesting');
  assert.equal(session.requester, undefined);
});

test('a lost extension response fixes the full requester identity before the command and retries explicitly', async () => {
  const {
    session,
    source,
    target,
    approver: requester,
    approverApplet: requesterApplet,
  } = await ready();
  requesterApplet.onExtend = () => {
    assert.deepEqual(session.requester, {
      id: hex(requester.id),
      publicKey: hex(requester.publicKey),
    });
    throw new Error('NFC disconnected');
  };
  await assert.rejects(
    session.configureCard(requesterApplet, requester, PIN, signal()),
    /NFC disconnected/,
  );
  assert.equal(requesterApplet.calls.length, 2);
  assert.equal(session.phase, 'requesting');
  await session.addCard(target);
  await session.addPreparedCard(prepared(target));
  for (const card of [
    source,
    hello(9, {id: requester.id}),
    {...requester, id: source.id},
  ]) {
    assert.throws(() => session.validateCard(card), /Wrong card/);
    const wrongApplet = applet(card);
    await assert.rejects(
      session.configureCard(wrongApplet, card, PIN, signal()),
      /Wrong card/,
    );
    assert.deepEqual(wrongApplet.calls, []);
  }
  requesterApplet.onExtend = undefined;
  await session.configureCard(requesterApplet, requester, PIN, signal());
  assert.equal(requesterApplet.calls.length, 4);
  assert.deepEqual(requesterApplet.calls[3], requesterApplet.calls[1]);
  assert.equal(session.phase, 'approving');
});

test('approval requires another initialized member of the same Bundle', async () => {
  const {session, source, target, approver, approverApplet} =
    await ready('approving');
  for (const card of [
    source,
    {...source, id: approver.id},
    target,
    {...target, bundle: bundle.slice()},
    {...approver, bundle: false},
    {...approver, bundle: new Uint8Array(32).fill(9)},
  ]) {
    assert.throws(() => session.validateCard(card), /another bundle card/);
    await assert.rejects(
      session.configureCard(approverApplet, card, PIN, signal()),
      /another bundle card/,
    );
  }
  assert.deepEqual(approverApplet.calls, []);
  assert.equal(session.approver, undefined);
});

test('join checks the full target identity and rejects a different Bundle before credentials', async () => {
  const {session, source, approver, target, targetApplet} =
    await ready('joining');
  for (const card of [
    source,
    approver,
    hello(9, {id: target.id, bundle: false}),
    {...target, id: Uint8Array.of(0, 0, 0, 9)},
    {...target, bundle: new Uint8Array(32).fill(9)},
  ]) {
    assert.throws(() => session.validateCard(card));
    await assert.rejects(
      session.configureCard(targetApplet, card, PIN, signal()),
    );
  }
  assert.deepEqual(targetApplet.calls, []);
  assert.equal(session.phase, 'joining');
});

for (const [phase, cardName, appletName] of [
  ['requesting', 'source', 'sourceApplet'],
  ['approving', 'approver', 'approverApplet'],
  ['joining', 'target', 'targetApplet'],
]) {
  test(`${phase} rejects blocked or uninitialized PINs without sending credentials`, async () => {
    const fixture = await ready(phase);
    const {session} = fixture;
    for (const pins of [
      {access: false, secret: 5},
      {access: 5, secret: false},
      {access: 0, secret: 5},
      {access: 5, secret: 0},
    ]) {
      const card = {...fixture[cardName], pins};
      await assert.rejects(
        session.configureCard(fixture[appletName], card, PIN, signal()),
        /Set up|PIN blocked/,
      );
    }
    await assert.rejects(
      session.configureCard(
        fixture[appletName],
        fixture[cardName],
        'short',
        signal(),
      ),
      /Secret PIN must/,
    );
    assert.deepEqual(fixture[appletName].calls, []);
    assert.equal(session.phase, phase);
  });

  test(`${phase} remains retryable on Secret PIN failure`, async () => {
    const fixture = await ready(phase);
    const {session} = fixture;
    const currentApplet = fixture[appletName];
    for (const tries of [4, 0]) {
      currentApplet.onAuthenticate = () => {
        throw new CBORAppletError({code: 'INVALID_PIN', tries});
      };
      await assert.rejects(
        session.configureCard(currentApplet, fixture[cardName], PIN, signal()),
        tries ? /Incorrect Secret PIN.*4/ : /Secret PIN blocked/,
      );
      assert.equal(session.phase, phase);
      assert.equal(session.busy, false);
    }
    assert.deepEqual(currentApplet.calls, [
      ['authenticate', {secret: true, pin: PIN}],
      ['authenticate', {secret: true, pin: PIN}],
    ]);
    currentApplet.onAuthenticate = undefined;
    await session.configureCard(
      currentApplet,
      fixture[cardName],
      PIN,
      signal(),
    );
    assert.notEqual(session.phase, phase);
  });

  test(`${phase} cancellation before or during authentication sends no command`, async () => {
    const fixture = await ready(phase);
    const {session} = fixture;
    const currentApplet = fixture[appletName];
    const before = new AbortController();
    before.abort();
    await assert.rejects(
      session.configureCard(
        currentApplet,
        fixture[cardName],
        PIN,
        before.signal,
      ),
      {code: 'CANCELLED'},
    );
    assert.deepEqual(currentApplet.calls, []);
    const during = new AbortController();
    currentApplet.onAuthenticate = () => during.abort();
    await assert.rejects(
      session.configureCard(
        currentApplet,
        fixture[cardName],
        PIN,
        during.signal,
      ),
      {code: 'CANCELLED'},
    );
    assert.deepEqual(currentApplet.calls, [
      ['authenticate', {secret: true, pin: PIN}],
    ]);
    assert.equal(session.phase, phase);
    assert.equal(session.busy, false);
    if (phase === 'requesting') assert.equal(session.requester, undefined);
  });
}

for (const [phase, cardName, appletName, hook, nextPhase] of [
  ['requesting', 'source', 'sourceApplet', 'onExtend', 'approving'],
  ['approving', 'approver', 'approverApplet', 'onApprove', 'joining'],
  ['joining', 'target', 'targetApplet', 'onJoin', 'complete'],
]) {
  test(`${phase} preserves a command ACK arriving after cancellation`, async () => {
    const fixture = await ready(phase);
    const {session} = fixture;
    const controller = new AbortController();
    fixture[appletName][hook] = () => controller.abort();
    await assert.rejects(
      session.configureCard(
        fixture[appletName],
        fixture[cardName],
        PIN,
        controller.signal,
      ),
      {code: 'CANCELLED'},
    );
    assert.equal(session.phase, nextPhase);
    assert.equal(session.busy, false);
    if (nextPhase === 'approving') {
      await session.configureCard(
        fixture.approverApplet,
        fixture.approver,
        PIN,
        signal(),
      );
    }
    if (nextPhase !== 'complete') {
      await session.configureCard(
        fixture.targetApplet,
        fixture.target,
        PIN,
        signal(),
      );
    }
    assert.equal(session.phase, 'complete');
  });

  test(`${phase} never automatically replays a lost command response`, async () => {
    const fixture = await ready(phase);
    const {session} = fixture;
    const currentApplet = fixture[appletName];
    currentApplet[hook] = () => {
      throw new Error('NFC disconnected');
    };
    await assert.rejects(
      session.configureCard(currentApplet, fixture[cardName], PIN, signal()),
      /NFC disconnected/,
    );
    assert.equal(currentApplet.calls.length, 2);
    assert.equal(session.phase, phase);
    assert.equal(session.busy, false);
    currentApplet[hook] = undefined;
    const card =
      phase === 'joining'
        ? {...fixture[cardName], bundle: bundle.slice()}
        : fixture[cardName];
    await session.configureCard(currentApplet, card, PIN, signal());
    assert.equal(currentApplet.calls.length, 4);
    assert.deepEqual(currentApplet.calls[3], currentApplet.calls[1]);
    assert.equal(session.phase, nextPhase);
  });
}

test('empty extension data does not freeze target editing', async () => {
  const {session, source, sourceApplet} = await ready();
  sourceApplet.onExtend = response => {
    response.data = new Uint8Array();
  };
  await assert.rejects(
    session.configureCard(sourceApplet, source, PIN, signal()),
    /Incomplete bundle response/,
  );
  assert.equal(session.phase, 'requesting');
  assert.deepEqual(session.requester, {
    id: hex(source.id),
    publicKey: hex(source.publicKey),
  });
  await session.removeTarget();
  assert.equal(session.phase, 'collecting');
  assert.equal(session.requester, undefined);
});

for (const [name, change] of [
  [
    'empty data',
    response => {
      response.data = new Uint8Array();
    },
  ],
  [
    'another sender',
    response => {
      response.publicKey = hello(9).publicKey;
    },
  ],
  [
    'truncated sender',
    response => {
      response.publicKey = response.publicKey.subarray(1);
    },
  ],
]) {
  test(`approval rejects ${name} and retains the original request for a later tap`, async () => {
    const {session, approver, approverApplet} = await ready('approving');
    approverApplet.onApprove = change;
    await assert.rejects(
      session.configureCard(approverApplet, approver, PIN, signal()),
      /Incomplete bundle response/,
    );
    assert.equal(session.phase, 'approving');
    assert.equal(session.approver, undefined);
    approverApplet.onApprove = undefined;
    await session.configureCard(approverApplet, approver, PIN, signal());
    assert.equal(session.phase, 'joining');
    assert.deepEqual(approverApplet.calls[3], approverApplet.calls[1]);
  });
}

for (const invalidBundle of [
  new Uint8Array(31).fill(42),
  new Uint8Array(32).fill(43),
]) {
  test(`join checks the entire Bundle hash (${invalidBundle.length} bytes)`, async () => {
    const {session, target, targetApplet} = await ready('joining');
    targetApplet.onJoin = response => {
      response.bundle = invalidBundle;
    };
    await assert.rejects(
      session.configureCard(targetApplet, target, PIN, signal()),
      /different bundle/,
    );
    assert.equal(session.phase, 'joining');
  });
}

test('cached packets survive transport buffer mutation and a lost join response', async () => {
  const {
    session,
    source,
    approver,
    target,
    sourceApplet,
    approverApplet,
    targetApplet,
  } = await ready();
  let responseBuffer;
  sourceApplet.onExtend = response => {
    responseBuffer = response.data;
  };
  await session.configureCard(sourceApplet, source, PIN, signal());
  responseBuffer.fill(0);
  approverApplet.onApprove = (response, request) => {
    assert.deepEqual(request.data, requestData);
    responseBuffer = response.data;
    request.data.fill(0);
  };
  await session.configureCard(approverApplet, approver, PIN, signal());
  responseBuffer.fill(0);
  targetApplet.onJoin = (_response, request) => {
    assert.deepEqual(request.data, enrollmentData);
    request.data.fill(0);
    request.publicKey.fill(0);
    throw new Error('NFC disconnected');
  };
  await assert.rejects(
    session.configureCard(targetApplet, target, PIN, signal()),
    /NFC disconnected/,
  );
  targetApplet.onJoin = undefined;
  await session.configureCard(targetApplet, {...target, bundle}, PIN, signal());
  assert.deepEqual(targetApplet.calls[3], targetApplet.calls[1]);
  assert.equal(session.phase, 'complete');
});

test('a command in flight excludes duplicate commands and target changes', async () => {
  const {session, source, target, sourceApplet} = await ready();
  let release;
  sourceApplet.onAuthenticate = () =>
    new Promise(resolve => {
      release = resolve;
    });
  const configuring = session.configureCard(
    sourceApplet,
    source,
    PIN,
    signal(),
  );
  assert.equal(session.busy, true);
  await assert.rejects(session.removeTarget(), /already in progress/);
  await assert.rejects(session.addCard(target), /already in progress/);
  await assert.rejects(
    session.configureCard(sourceApplet, source, PIN, signal()),
    /already in progress/,
  );
  assert.equal(sourceApplet.calls.length, 1);
  release();
  await configuring;
  assert.equal(session.phase, 'approving');
  assert.equal(session.busy, false);
});

test('collecting and complete never send credentials or commands', async () => {
  for (const phase of ['collecting', 'complete']) {
    const {session, source} = await ready(phase);
    const currentApplet = applet(source);
    await assert.rejects(
      session.configureCard(currentApplet, source, PIN, signal()),
      phase === 'collecting' ? /Add a card first/ : /extension complete/,
    );
    assert.deepEqual(currentApplet.calls, []);
  }
});
