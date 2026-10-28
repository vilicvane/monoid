import assert from 'node:assert/strict';
import {test} from 'node:test';

import {CardSecretPINSession} from '../.bld/app/@components/views/safe/@card/card-secret-pin-session.js';
import {CBORAppletError} from '../.bld/app/@lib/cbor-applet.js';
import {HeldPINs} from '../.bld/app/@lib/held-pins.js';
import {CardPINError} from '../.bld/app/@lib/monoid/card-pins.js';

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

for (const backed of [false, true]) {
  for (const result of ['correct', 'cancel', 'blocked']) {
    test(`${backed ? 'procedure' : 'page'} wrong Secret PIN: ${result}, no resubmission before input`, async () => {
      const procedure = backed ? procedureFixture() : undefined;
      const session = new CardSecretPINSession(procedure);
      await remember(session);
      const owner = session.signal;
      const authenticateSecond = session.onAuthenticated(second, OTHER_PIN);
      let attempts = 0;
      let prompts = 0;
      const run = session.run(
        [first],
        async (card, signal, message) => {
          assert.equal(card, first);
          assert.equal(signal.aborted, false);
          assert.equal(attempts, 1);
          assert.equal(message, 'Incorrect PIN, tries remaining: 4');
          assert.equal(procedure?.secretPIN(first), undefined);
          prompts++;
          return result === 'cancel' ? undefined : OTHER_PIN;
        },
        async credentials => {
          const current = credentials(first);
          attempts++;
          if (attempts === 1)
            throw new CardPINError(
              'Secret',
              result === 'blocked' ? 0 : 4,
              true,
              new CBORAppletError({
                code: 'INVALID_PIN',
                tries: result === 'blocked' ? 0 : 4,
              }),
            );
          assert.equal(current.pin, OTHER_PIN);
          current.onAuthenticated();
        },
      );
      if (result === 'blocked') await assert.rejects(run, /Secret PIN blocked/);
      else await run;
      assert.equal(prompts, result === 'blocked' ? 0 : 1);
      assert.equal(attempts, result === 'correct' ? 2 : 1);
      assert.equal(owner.aborted, false);
      authenticateSecond();
      await session.run([second], noPrompt, async credentials =>
        assert.equal(credentials(second).pin, OTHER_PIN),
      );
      session.clear();
    });
  }
}

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

for (const failure of [
  new CBORAppletError({code: 'INVALID_PIN', tries: 4}),
  new CardPINError('Secret', 4, true, new Error('later authentication failed')),
]) {
  test(`a PIN-shaped error after authenticated work never repeats that tap (${failure.constructor.name})`, async () => {
    const session = new CardSecretPINSession();
    session.onAuthenticated(first, PIN)();
    let writes = 0;
    await assert.rejects(
      session.run([first], noPrompt, async credentials => {
        credentials(first).onAuthenticated();
        writes++;
        throw failure;
      }),
      error => error === failure,
    );
    assert.equal(writes, 1);
    session.clear();
  });
}
