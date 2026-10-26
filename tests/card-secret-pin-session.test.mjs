import assert from 'node:assert/strict';
import {test} from 'node:test';

import {CardSecretPINSession} from '../.bld/app/@components/views/safe/@card/card-secret-pin-session.js';
import {CBORAppletError} from '../.bld/app/@lib/cbor-applet.js';
import {MonoidCardError} from '../.bld/app/@lib/monoid/card-error.js';

const first = {id: '00000001', publicKey: 'first', bundle: false};
const second = {id: '00000002', publicKey: 'second', bundle: false};
const PIN = 'First-42';
const OTHER_PIN = 'Second-42';
const noPrompt = () => assert.fail('A verified card must reuse its PIN');

function procedureFixture() {
  const pins = new Map();
  return {
    pins,
    secretPIN: card => pins.get(card.publicKey),
    holdSecretPIN: (card, pin) => pins.set(card.publicKey, pin),
    dropSecretPIN: card => pins.delete(card.publicKey),
  };
}

test('procedure PINs are reused and only verified credentials are forwarded', async () => {
  const procedure = procedureFixture();
  procedure.holdSecretPIN(first, PIN);
  const session = new CardSecretPINSession(procedure);
  await session.run([first], noPrompt, async credentials => {
    assert.equal(credentials(first).pin, PIN);
    credentials(first).onAuthenticated();
  });
  await session.run(
    [second],
    async () => OTHER_PIN,
    async credentials => {
      const next = credentials(second);
      assert.equal(procedure.secretPIN(second), undefined);
      next.onAuthenticated();
      assert.equal(procedure.secretPIN(second), OTHER_PIN);
    },
  );
  session.clear();
  assert.equal(
    procedure.secretPIN(first),
    PIN,
    'page clear preserves transferred procedure PINs',
  );
  assert.equal(procedure.secretPIN(second), OTHER_PIN);
  const late = session.onAuthenticated(
    {...second, publicKey: 'late'},
    OTHER_PIN,
  );
  session.clear();
  late();
  assert.equal(procedure.pins.has('late'), false);
});

test('rejected procedure PIN is dropped and an explicit retry prompts', async () => {
  const procedure = procedureFixture();
  procedure.holdSecretPIN(first, PIN);
  const session = new CardSecretPINSession(procedure);
  let attempts = 0;
  await assert.rejects(
    session.run([first], noPrompt, async credentials => {
      credentials(first);
      attempts++;
      throw new MonoidCardError('Incorrect Secret PIN', {
        cause: new CBORAppletError({code: 'INVALID_PIN', tries: 4}),
      });
    }),
    /Incorrect Secret PIN/,
  );
  assert.equal(attempts, 1);
  assert.equal(procedure.secretPIN(first), undefined);
  let prompts = 0;
  await session.run(
    [first],
    async () => {
      prompts++;
      return OTHER_PIN;
    },
    async credentials => {
      credentials(first).onAuthenticated();
    },
  );
  assert.equal(prompts, 1);
  assert.equal(procedure.secretPIN(first), OTHER_PIN);
});

async function remember(session, card = first, pin = PIN) {
  await session.run(
    [card],
    async () => pin,
    async credentials => {
      credentials(card).onAuthenticated();
    },
  );
}

test('an uncached card closes its discovery before requesting a PIN bound to that card', async () => {
  const session = new CardSecretPINSession();
  await remember(session);
  const events = [];
  let scans = 0;
  await session.run(
    [first, second],
    async card => {
      assert.deepEqual(card, second);
      assert.deepEqual(events, ['scan closed']);
      events.push('PIN requested');
      return OTHER_PIN;
    },
    async credentials => {
      scans++;
      try {
        const {pin, onAuthenticated} = credentials(second);
        assert.equal(pin, OTHER_PIN);
        events.push('authenticated');
        onAuthenticated();
      } finally {
        events.push('scan closed');
      }
    },
  );
  assert.equal(scans, 2);
  for (const [card, expected] of [
    [second, OTHER_PIN],
    [first, PIN],
  ]) {
    await session.run([first, second], noPrompt, async credentials => {
      assert.equal(credentials(card).pin, expected);
    });
  }
});

test('a rejected cached PIN is discarded and neither authentication nor writes are retried', async () => {
  const session = new CardSecretPINSession();
  await remember(session);
  let attempts = 0;
  const failure = new MonoidCardError('Incorrect Secret PIN, 4 tries left', {
    cause: new CBORAppletError({code: 'INVALID_PIN', tries: 4}),
  });
  await assert.rejects(
    session.run([first], noPrompt, async credentials => {
      assert.equal(credentials(first).pin, PIN);
      attempts++;
      throw failure;
    }),
    error => error === failure,
  );
  assert.equal(attempts, 1);
  let prompts = 0;
  await session.run(
    [first],
    async () => {
      prompts++;
      return OTHER_PIN;
    },
    async credentials => {
      assert.equal(credentials(first).pin, OTHER_PIN);
    },
  );
  assert.equal(prompts, 1);
});

test('a failure after successful authentication preserves the PIN but never replays the failed operation', async () => {
  const session = new CardSecretPINSession();
  let attempts = 0;
  await assert.rejects(
    session.run(
      [first],
      async () => PIN,
      async credentials => {
        credentials(first).onAuthenticated();
        attempts++;
        throw new Error('Unknown write result');
      },
    ),
    /Unknown write result/,
  );
  assert.equal(attempts, 1);
  await session.run([first], noPrompt, async credentials => {
    assert.equal(credentials(first).pin, PIN);
  });
});

test('clearing a flow aborts pending PIN input and ignores late authenticated callbacks', async () => {
  const session = new CardSecretPINSession();
  const late = session.onAuthenticated(first, PIN);
  let resolve;
  let promptSignal;
  let scans = 0;
  const pending = session.run(
    [first],
    async (_card, signal) => {
      promptSignal = signal;
      return new Promise(accept => {
        resolve = accept;
      });
    },
    async () => {
      scans++;
    },
  );
  session.clear();
  assert.equal(promptSignal.aborted, true);
  late();
  resolve(PIN);
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(scans, 0);
  let prompts = 0;
  await session.run(
    [first],
    async () => {
      prompts++;
      return PIN;
    },
    async () => {},
  );
  assert.equal(prompts, 1);
});

test('the same short Card ID cannot reuse a PIN after its public key or Bundle changes', async () => {
  for (const changed of [
    {...first, publicKey: 'replacement'},
    {...first, bundle: 'new-bundle'},
  ]) {
    const session = new CardSecretPINSession();
    await remember(session);
    let prompts = 0;
    await session.run(
      [changed],
      async () => {
        prompts++;
        return OTHER_PIN;
      },
      async credentials => {
        assert.equal(credentials(changed).pin, OTHER_PIN);
      },
    );
    assert.equal(prompts, 1);
  }
});

test('explicitly entering a new PIN while adding a card takes precedence over its earlier verified PIN', async () => {
  const session = new CardSecretPINSession();
  await remember(session);
  await session.run(
    [],
    async () => OTHER_PIN,
    async credentials => {
      assert.equal(credentials(first).pin, OTHER_PIN);
    },
  );
});
