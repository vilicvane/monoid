import assert from 'node:assert/strict';
import {test} from 'node:test';

import {observable, reaction, runInAction} from 'mobx';

// eslint-disable-next-line @mufan/scoped-modules -- Exercise the pending list without initializing platform services.
import {
  getPendingActionExpiry,
  getPendingActions,
} from '../.bld/app/@lib/pending-action.js';

function fixture() {
  const responding = observable.set();
  const service = {
    requests: observable.map([], {deep: false}),
    sessions: observable.map([], {deep: false}),
    isRespondingToRequest(id) {
      return responding.has(id);
    },
  };
  const session = {topic: 'session'};

  runInAction(() => service.sessions.set(session.topic, session));

  return {service, session, responding};
}

function request(id, topic = 'session', method = 'personal_sign') {
  return {id, topic, params: {request: {method, params: []}}};
}

test('the displayed deadline uses the earlier request or session expiry in milliseconds', () => {
  const action = {
    request: request(1),
    session: {expiry: 200},
  };

  assert.equal(getPendingActionExpiry(action), 200_000);

  action.request.params.request.expiryTimestamp = 100;
  assert.equal(getPendingActionExpiry(action), 100_000);

  action.request.params.request.expiryTimestamp = 300;
  assert.equal(getPendingActionExpiry(action), 200_000);
});

test('requests from the same session remain separate and keep arrival order', () => {
  const {service, session} = fixture();
  const first = request(20);
  const second = request(10);

  runInAction(() => {
    service.requests.set(first.id, first);
    service.requests.set(second.id, second);
  });

  assert.deepEqual(getPendingActions(service), [
    {
      id: 'wallet-connect-request:20',
      type: 'wallet-connect-request',
      request: first,
      session,
    },
    {
      id: 'wallet-connect-request:10',
      type: 'wallet-connect-request',
      request: second,
      session,
    },
  ]);
});

test('unsupported methods remain available for the existing error and rejection flow', () => {
  const {service} = fixture();
  const pending = request(1, 'session', 'unsupported_method');

  runInAction(() => service.requests.set(pending.id, pending));

  assert.equal(getPendingActions(service)[0].request, pending);
});

test('an observer hides busy requests, restores failed attempts, and removes completed retries', context => {
  const {service, responding} = fixture();
  const snapshots = [];
  context.after(
    reaction(
      () => getPendingActions(service).map(action => action.id),
      ids => snapshots.push(ids),
      {fireImmediately: true},
    ),
  );

  runInAction(() => service.requests.set(1, request(1)));
  runInAction(() => responding.add(1));
  runInAction(() => responding.delete(1));
  runInAction(() => responding.add(1));
  runInAction(() => service.requests.delete(1));
  runInAction(() => responding.delete(1));

  assert.deepEqual(snapshots, [
    [],
    ['wallet-connect-request:1'],
    [],
    ['wallet-connect-request:1'],
    [],
    [],
  ]);
  assert.deepEqual(getPendingActions(service), []);
});

test('removing one request preserves its siblings, and session removal clears its remaining actions', () => {
  const {service} = fixture();
  const otherSession = {topic: 'other-session'};

  runInAction(() => {
    service.sessions.set(otherSession.topic, otherSession);
    service.requests.set(1, request(1));
    service.requests.set(2, request(2));
    service.requests.set(3, request(3, otherSession.topic));
  });
  runInAction(() => service.requests.delete(1));

  assert.deepEqual(
    getPendingActions(service).map(action => action.id),
    ['wallet-connect-request:2', 'wallet-connect-request:3'],
  );

  runInAction(() => {
    service.sessions.delete('session');
    service.requests.delete(2);
  });

  const remaining = getPendingActions(service);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, 'wallet-connect-request:3');
  assert.equal(remaining[0].session, otherSession);
});
