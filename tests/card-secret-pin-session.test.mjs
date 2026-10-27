import assert from 'node:assert/strict';
import {test} from 'node:test';

import {CardSecretPINSession} from '../.bld/app/@components/views/safe/@card/card-secret-pin-session.js';
import {CBORAppletError} from '../.bld/app/@lib/cbor-applet.js';
import {HeldPINs} from '../.bld/app/@lib/held-pins.js';
import {MonoidCardError} from '../.bld/app/@lib/monoid/card-error.js';

import {pinClock} from './helpers/held-pins.mjs';

const first = {id: '00000001', publicKey: 'first', bundle: false};
const second = {id: '00000002', publicKey: 'second', bundle: false};
const PIN = 'First-42';
const OTHER_PIN = 'Second-42';
const noPrompt = () => assert.fail('A verified card must reuse its PIN');

for (const backed of [false, true]) {
  test(`${backed ? 'procedure' : 'page'} Secret PIN expiry re-prompts without losing the selected cards`, async t => {
    const clock = pinClock(t);
    const session = new CardSecretPINSession(
      backed ? procedureFixture() : undefined,
    );
    await remember(session);
    clock.elapse(5 * 60_000);
    let prompts = 0;
    await session.run(
      [first],
      async card => {
        assert.equal(card, first);
        prompts++;
        return PIN;
      },
      async credentials => {
        credentials(first).onAuthenticated();
      },
    );
    assert.equal(prompts, 1);
    const late = session.onAuthenticated(second, OTHER_PIN);
    clock.visibility('hidden');
    clock.visibility('visible');
    late();
    await session.run(
      [second],
      async card => {
        assert.equal(card, second);
        prompts++;
        return OTHER_PIN;
      },
      async credentials => assert.equal(credentials(second).pin, OTHER_PIN),
    );
    assert.equal(prompts, 2);
    session.clear();
  });
}

function procedureFixture() {
  const pins = new HeldPINs();
  return {
    pins,
    secretPINWriter: () => {
      const owner = pins.signal;
      return (card, pin) => pins.set(card.publicKey, pin, owner);
    },
    secretPIN: card => pins.get(card.publicKey),
    holdSecretPIN: (card, pin, owner) => pins.set(card.publicKey, pin, owner),
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
  assert.equal(procedure.pins.get('late'), undefined);
});

test('a procedure drop during PIN input prevents its late authentication from refilling', async t => {
  const clock = pinClock(t);
  const procedure = procedureFixture();
  procedure.holdSecretPIN(first, PIN);
  const session = new CardSecretPINSession(procedure);
  let scans = 0;
  await session.run(
    [first],
    async card => {
      assert.equal(card, second);
      clock.visibility('hidden');
      clock.visibility('visible');
      return OTHER_PIN;
    },
    async credentials => {
      scans++;
      credentials(second).onAuthenticated();
    },
  );
  assert.equal(
    scans,
    2,
    'the PIN handoff completes without repeating a mutation',
  );
  assert.equal(procedure.secretPIN(first), undefined);
  assert.equal(procedure.secretPIN(second), undefined);
});

test('rejected procedure PIN is dropped and an explicit retry prompts', async () => {
  const procedure = procedureFixture();
  procedure.holdSecretPIN(first, PIN);
  const session = new CardSecretPINSession(procedure);
  const owner = session.signal;
  const procedureOwner = procedure.pins.signal;
  const authenticateSecond = session.onAuthenticated(second, OTHER_PIN);
  const failure = new MonoidCardError('Incorrect Secret PIN', {
    cause: new CBORAppletError({code: 'INVALID_PIN', tries: 4}),
  });
  let attempts = 0;
  await assert.rejects(
    session.run([first], noPrompt, async credentials => {
      credentials(first);
      attempts++;
      throw failure;
    }),
    error => error === failure,
  );
  assert.equal(attempts, 1);
  assert.equal(owner.aborted, false);
  assert.equal(procedureOwner.aborted, false);
  assert.equal(procedure.secretPIN(first), undefined);
  authenticateSecond();
  assert.equal(procedure.secretPIN(second), OTHER_PIN);
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
  const owner = session.signal;
  const authenticateSecond = session.onAuthenticated(second, OTHER_PIN);
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
  assert.equal(owner.aborted, false);
  assert.equal(session.signal, owner);
  authenticateSecond();
  await session.run([second], noPrompt, async credentials => {
    assert.equal(credentials(second).pin, OTHER_PIN);
  });
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
