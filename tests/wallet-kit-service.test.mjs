import assert from 'node:assert/strict';
import {EventEmitter, getEventListeners} from 'node:events';
import {mock, test} from 'node:test';

import {WalletKitService} from '../.bld/app/@services/wallet-kit-service.js';

const TOPIC = 'a'.repeat(64);
const OTHER_TOPIC = 'c'.repeat(64);
const uri = (topic = TOPIC) =>
  `wc:${topic}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`;
const proposal = (topic = TOPIC, id = 1) => ({
  id,
  params: {
    pairingTopic: topic,
    expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
  },
});

function setup() {
  const kit = Object.assign(new EventEmitter(), {
    core: {pairing: {events: new EventEmitter()}},
    pair: mock.fn(async () => {}),
    rejectSession: mock.fn(async () => {}),
  });
  const service = new WalletKitService(kit);
  const controller = new AbortController();

  return {kit, service, controller};
}

function assertClean(kit, signal) {
  assert.deepEqual(kit.eventNames(), ['proposal_expire']);
  assert.equal(kit.listenerCount('proposal_expire'), 1);
  assert.deepEqual(kit.core.pairing.events.eventNames().sort(), [
    'pairing_delete',
    'pairing_expire',
  ]);
  for (const event of kit.core.pairing.events.eventNames()) {
    assert.equal(kit.core.pairing.events.listenerCount(event), 1);
  }
  assert.deepEqual(getEventListeners(signal, 'abort'), []);
}

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
