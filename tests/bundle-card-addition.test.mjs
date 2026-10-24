import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';

import {observable} from 'mobx';

import {CardSecretPINSession} from '../.bld/app/@components/views/safe/@card/card-secret-pin-session.js';
import {
  MonoidCardError,
  MonoidWrongCardError,
} from '../.bld/app/@lib/monoid/card-error.js';
import {initializeMonoidCard} from '../.bld/app/@lib/monoid/initialize-card.js';
import {
  MonoidAppletHello,
  MonoidAppletInvalidPINError,
} from '../.bld/app/@lib/monoid/monoid-applet.js';

let fixture;
const owners = [];
const sameDependencies = (left, right) =>
  left?.length === right?.length &&
  left.every((value, index) => Object.is(value, right[index]));

mock.module('react', {
  namedExports: {
    useRef: current => fixture.slot(() => ({current})),
    useState(initial) {
      const owner = fixture;
      const slot = owner.slot(() => ({
        value: typeof initial === 'function' ? initial() : initial,
      }));
      return [
        slot.value,
        value => {
          slot.value = typeof value === 'function' ? value(slot.value) : value;
        },
      ];
    },
    useEffect(effect, dependencies) {
      const slot = fixture.slot(() => ({}));
      if (sameDependencies(slot.dependencies, dependencies)) return;
      fixture.effects.push(() => {
        slot.cleanup?.();
        slot.dependencies = dependencies;
        slot.cleanup = effect();
      });
    },
  },
});
mock.module('react/jsx-runtime', {
  namedExports: {
    jsx: (type, props) => ({type, props}),
    jsxs: (type, props) => ({type, props}),
    Fragment: 'fragment',
  },
});
mock.module('mobx', {
  namedExports: {
    observable,
    runInAction: action => action(),
    reaction(expression, effect) {
      const owner = fixture;
      let current = expression();
      const update = () => {
        const next = expression();
        if (next === current) return;
        current = next;
        effect(next);
      };
      owner.reactions.add(update);
      return () => owner.reactions.delete(update);
    },
  },
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => fixture.entrances},
});
mock.module('../.bld/app/@components/views/safe/@card/card-backup-session.js', {
  namedExports: {
    readBackupCardIdentity: hello => ({
      id: Buffer.from(hello.id).toString('hex'),
      publicKey: Buffer.from(hello.publicKey).toString('hex'),
      bundle:
        hello.bundle === false
          ? false
          : Buffer.from(hello.bundle).toString('hex'),
    }),
  },
});
mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {
    MonoidAppletHello,
    MonoidAppletInvalidPINError,
    MonoidCardError,
    MonoidWrongCardError,
    initializeMonoidCard,
  },
});
mock.module('../.bld/app/@services/index.js', {
  namedExports: {
    isCredentialRequestCancelled: error => error?.code === 'CANCELLED',
  },
});
mock.module('../.bld/app/@components/@monoid/monoid-scan-prompt.js', {
  namedExports: {MonoidScanStatePromptContentHighlight: 'highlight'},
});
mock.module('../.bld/app/@components/@monoid/pin-input-placeholder.js', {
  namedExports: {
    PINKind: ({kind}) => kind,
    getPINInputPlaceholder: (kind, prefix) => ({
      placeholder: `${prefix} ${kind} PIN`,
    }),
  },
});
mock.module('../.bld/app/@components/@monoid/use-isodep-scan-prompt.js', {
  namedExports: {
    useIsoDepScanPrompt: () => (label, callback) => {
      const scan = {
        ...deferred(),
        label,
        callback,
        signal: new AbortController().signal,
      };
      fixture.scans.push(scan);
      return scan.promise;
    },
  },
});
mock.module('../.bld/app/@components/@ui/confirm-popup.js', {
  namedExports: {ConfirmPopup: 'confirm-popup'},
});
mock.module('../.bld/app/@components/@ui/toast.js', {
  namedExports: {useToast: () => value => fixture.toasts.push(value)},
});
mock.module('../.bld/app/@components/@ui/use-input-modal.js', {
  namedExports: {
    useInputModal: () => [
      'pin-input',
      async (options, signal) => {
        const owner = fixture;
        owner.events.push('pin-input');
        owner.inputs.push(options);
        const pin = owner.inputPending
          ? await owner.inputPending.promise
          : owner.pin;
        return signal?.aborted ? undefined : pin;
      },
    ],
  },
});
mock.module('../.bld/app/@components/views/safe/@card/card-setup-pin.js', {
  namedExports: {CardSetupPIN: 'setup-pin'},
});
mock.module('../.bld/app/@components/views/safe/@card/read-card-for-setup.js', {
  namedExports: {
    readCardForSetup: async (_sessionId, _applet, _status, signal) => {
      signal.throwIfAborted();
      return fixture.result;
    },
  },
});

const {useBundleCardAddition} = await import(
  '../.bld/app/@components/views/safe/@card/use-bundle-card-addition.js'
);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
}

function find(node, type) {
  if (!node) return;
  if (node.type === type) return node;
  const children = Array.isArray(node) ? node : node.props?.children;
  return (Array.isArray(children) ? children : [children])
    .map(child => find(child, type))
    .find(Boolean);
}

function hello({bundle = false, pins = {access: 5, secret: 5}} = {}) {
  return {
    id: Uint8Array.from([1, 2, 3, 4]),
    publicKey: Uint8Array.from([4, ...new Array(64).fill(12)]),
    version: 0,
    bundle,
    authority: false,
    pins,
  };
}

function mount(options = {}) {
  const state = {
    active: true,
    slots: [],
    effects: [],
    reactions: new Set(),
    scans: [],
    added: [],
    installs: [],
    inputs: [],
    toasts: [],
    errors: [],
    events: [],
    credentialCalls: [],
    result: {type: 'ready', hello: hello()},
    pin: undefined,
    pinSession: {
      clear() {
        state.credentialCalls.push({type: 'clear'});
      },
      async authenticate(signal) {
        state.events.push('vault-authenticate');
        state.credentialCalls.push({type: 'authenticate', signal});
        await state.credentialPending?.promise;
        if (state.credentialFailure) throw state.credentialFailure;
        signal?.throwIfAborted();
      },
    },
    slot(create) {
      const index = this.cursor++;
      return (this.slots[index] ??= create());
    },
    render() {
      fixture = this;
      this.cursor = 0;
      this.hook = useBundleCardAddition(this.options);
      for (const effect of this.effects.splice(0)) effect();
      return this.hook;
    },
    deactivate() {
      this.active = false;
      for (const react of this.reactions) react();
      this.render();
    },
    unmount() {
      for (const slot of this.slots) slot.cleanup?.();
      this.slots = [];
    },
    async tap() {
      const scan = this.scans.at(-1);
      await scan.callback('session', () => {}, scan.signal);
    },
  };
  state.options = {
    secretPINSession: new CardSecretPINSession(),
    isActive: () => state.active,
    validateAddition: options.validateAddition ?? (() => {}),
    onAdded: async value => state.added.push(value),
    onNeedsInstall: information => state.installs.push(information),
  };
  state.entrances = {
    errorService: {
      catch: value =>
        typeof value === 'function'
          ? (...args) => value(...args).catch(error => state.errors.push(error))
          : value.catch(error => state.errors.push(error)),
    },
    monoidApplet: {},
    monoidCredentialsStore: {createPINSession: () => state.pinSession},
    cardStore: {get: () => undefined},
  };
  owners.push(state);
  state.render();
  return state;
}

afterEach(() => owners.splice(0).forEach(owner => owner.unmount()));

test('an initialized target is added after native cleanup without a PIN prompt', async () => {
  const state = mount();
  const operation = state.hook.addCard();
  await state.tap();
  assert.deepEqual(state.added, []);
  assert.deepEqual(state.inputs, []);
  state.scans[0].resolve();
  await operation;
  assert.deepEqual(state.added, [state.result.hello]);
  assert.deepEqual(state.credentialCalls, []);
});

test('a verified target is retained when navigation happens during native cleanup', async () => {
  const state = mount();
  const operation = state.hook.addCard();
  await state.tap();
  state.deactivate();
  state.scans[0].resolve();
  await operation;
  assert.deepEqual(state.added, [state.result.hello]);
  assert.deepEqual(state.inputs, []);
});

test('missing applets hand off only after native cleanup and do not add a target', async () => {
  const state = mount();
  state.result = {type: 'setup', cardInformation: {cplc: 'test'}};
  const operation = state.hook.addCard();
  await state.tap();
  assert.deepEqual(state.installs, []);
  state.scans[0].resolve();
  await operation;
  assert.deepEqual(state.installs, [state.result.cardInformation]);
  assert.deepEqual(state.added, []);
});

test('a rejected target never opens PIN setup or reset confirmation', async () => {
  const state = mount({
    validateAddition: () => {
      throw new MonoidCardError('Card already belongs to this bundle');
    },
  });
  state.result.hello = hello({bundle: new Uint8Array(16).fill(2)});
  const operation = state.hook.addCard();
  const rejected = assert.rejects(operation, /already belongs/);
  await assert.rejects(state.tap(), /already belongs/);
  state.scans[0].reject(
    new MonoidCardError('Card already belongs to this bundle'),
  );
  await rejected;
  state.render();
  assert.deepEqual(state.added, []);
  assert.deepEqual(state.inputs, []);
  assert.equal(find(state.hook.content, 'confirm-popup'), undefined);
  assert.equal(find(state.hook.content, 'setup-pin'), undefined);
});

test('a bundled target requires the existing two-stage reset confirmation after cleanup', async () => {
  const state = mount();
  state.result.hello = hello({bundle: new Uint8Array(16).fill(2)});
  const operation = state.hook.addCard();
  await state.tap();
  state.render();
  assert.equal(find(state.hook.content, 'confirm-popup'), undefined);
  state.scans[0].resolve();
  await operation;
  state.render();
  const confirmation = find(state.hook.content, 'confirm-popup');
  assert.equal(confirmation.props.title, 'Reset card and join bundle?');
  assert.deepEqual(confirmation.props.confirmText, [
    'I understand, add card',
    'Confirm',
  ]);
  assert.deepEqual(state.added, []);
  assert.deepEqual(state.inputs, []);
  confirmation.props.onCancel();
  state.render();
  assert.equal(state.hook.busy, false);
  assert.equal(find(state.hook.content, 'confirm-popup'), undefined);
});

test('a target missing PINs uses shared PIN setup and preserves confirmed setup after navigation', async () => {
  const state = mount();
  state.result.hello = hello({pins: {access: false, secret: false}});
  const operation = state.hook.addCard();
  await state.tap();
  state.scans[0].resolve();
  await operation;
  state.render();
  const setup = find(state.hook.content, 'setup-pin');
  assert.equal(setup.props.hello, state.result.hello);
  assert.equal(setup.props.pinSession, state.pinSession);
  assert.equal(setup.props.secretPINSession, state.options.secretPINSession);
  assert.equal(state.hook.buttonLabel, 'Set Secret PIN');

  state.deactivate();
  const initialized = hello();
  setup.props.onInitialized(initialized);
  setup.props.onFinished(true, initialized);
  await Promise.resolve();
  assert.deepEqual(state.added, [initialized]);
});

test('resetting an extension target remembers its new Secret PIN only for the replacement identity', async () => {
  const state = mount();
  const original = hello({bundle: new Uint8Array(32).fill(2)});
  let current = original;
  state.pin = 'New-42';
  state.pinSession.removePIN = async () => {};
  state.pinSession.setPIN = async () => {};
  state.entrances.cardStore.set = card => card;
  state.entrances.monoidApplet.openSession = async () => ({
    hello: async () => current,
    reset: async () => {
      current = {
        ...hello({pins: {access: false, secret: false}}),
        id: Uint8Array.from([5, 6, 7, 8]),
        publicKey: Uint8Array.from([4, ...new Array(64).fill(34)]),
      };
    },
    setPIN: async () => {
      current = {...current, pins: {access: 5, secret: 5}};
    },
    authenticate: async () => {},
  });
  await state.hook.acceptCard(original);
  state.render();
  const adding = find(state.hook.content, 'confirm-popup').props.onConfirm();
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.deepEqual(state.events, [
    'vault-authenticate',
    'pin-input',
    'pin-input',
    'pin-input',
    'pin-input',
  ]);
  await state.tap();
  state.scans.at(-1).resolve();
  await adding;
  assert.deepEqual(state.added, [current]);
  const identity = card => ({
    id: Buffer.from(card.id).toString('hex'),
    publicKey: Buffer.from(card.publicKey).toString('hex'),
    bundle:
      card.bundle === false ? false : Buffer.from(card.bundle).toString('hex'),
  });
  await state.options.secretPINSession.run(
    [identity(current)],
    async () => {
      assert.fail('Initialization already confirmed the new PIN');
    },
    async credentials => {
      assert.equal(credentials(identity(current)).pin, state.pin);
    },
  );
  let prompted = false;
  await state.options.secretPINSession.run(
    [identity(original)],
    async () => {
      prompted = true;
    },
    async () => {
      assert.fail('Old card identity must not inherit the PIN');
    },
  );
  assert.equal(prompted, true);
  assert.equal(
    state.credentialCalls.filter(call => call.type === 'authenticate').length,
    1,
  );
  assert.equal(state.credentialCalls.at(-1).type, 'clear');
});

async function resetCandidate() {
  const state = mount();
  await state.hook.acceptCard(hello({bundle: new Uint8Array(32).fill(2)}));
  state.render();
  return state;
}

test('an extension reset waits for vault unlock before requesting its new Secret PIN', async () => {
  const state = await resetCandidate();
  state.credentialPending = deferred();
  state.inputPending = deferred();
  const adding = find(state.hook.content, 'confirm-popup').props.onConfirm();
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.deepEqual(state.events, ['vault-authenticate']);
  assert.deepEqual(state.inputs, []);
  assert.deepEqual(state.scans, []);
  state.credentialPending.resolve();
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.deepEqual(state.events, ['vault-authenticate', 'pin-input']);
  assert.equal(state.inputs[0].placeholder, 'Set Secret PIN');
  assert.deepEqual(state.scans, []);
  state.inputPending.resolve(undefined);
  await adding;
  assert.equal(state.credentialCalls.at(-1).type, 'clear');
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.added, []);
});

test('cancelling vault unlock during an extension reset does not request a PIN or scan', async () => {
  const state = await resetCandidate();
  state.credentialFailure = Object.assign(new Error('Cancelled'), {
    code: 'CANCELLED',
  });
  await find(state.hook.content, 'confirm-popup').props.onConfirm();
  assert.deepEqual(state.inputs, []);
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.added, []);
  assert.equal(state.credentialCalls.at(-1).type, 'clear');
  assert.deepEqual(state.errors, []);
});

for (const destination of ['inactive', 'unmounted']) {
  test(`an extension reset does not request a PIN after vault unlock when its page becomes ${destination}`, async () => {
    const state = await resetCandidate();
    state.credentialPending = deferred();
    const adding = find(state.hook.content, 'confirm-popup').props.onConfirm();
    if (destination === 'unmounted') state.unmount();
    else state.deactivate();
    state.credentialPending.resolve();
    await adding;
    assert.deepEqual(state.inputs, []);
    assert.deepEqual(state.scans, []);
    assert.deepEqual(state.added, []);
    assert.equal(state.credentialCalls.at(-1).type, 'clear');
    assert.deepEqual(state.errors, []);
  });

  test(`an extension reset does not scan after PIN entry when its page becomes ${destination}`, async () => {
    const state = await resetCandidate();
    state.inputPending = deferred();
    const adding = find(state.hook.content, 'confirm-popup').props.onConfirm();
    for (let index = 0; index < 10; index++) await Promise.resolve();
    assert.equal(state.inputs.length, 1);
    if (destination === 'unmounted') state.unmount();
    else state.deactivate();
    state.inputPending.resolve('New-42');
    await adding;
    assert.deepEqual(state.scans, []);
    assert.deepEqual(state.added, []);
    assert.equal(state.credentialCalls.at(-1).type, 'clear');
    assert.deepEqual(state.errors, []);
  });
}

test('an installed target retaining its original bundle opens reset confirmation without mutation or another scan', async () => {
  const state = mount();
  const installed = hello({bundle: new Uint8Array(16).fill(2)});
  await state.hook.acceptCard(installed);
  state.render();

  const confirmation = find(state.hook.content, 'confirm-popup');
  assert.equal(confirmation.props.title, 'Reset card and join bundle?');
  assert.deepEqual(confirmation.props.confirmText, [
    'I understand, add card',
    'Confirm',
  ]);
  assert.deepEqual(state.added, []);
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.inputs, []);
});

test('the installer handoff validates the target and stays inactive until its page returns', async () => {
  const state = mount({
    validateAddition: value => {
      if (value.bundle !== false)
        throw new MonoidCardError('Card already belongs to this bundle');
    },
  });
  await assert.rejects(
    state.hook.acceptCard(hello({bundle: new Uint8Array(16).fill(2)})),
    /already belongs/,
  );
  state.render();
  assert.equal(find(state.hook.content, 'confirm-popup'), undefined);
  assert.deepEqual(state.added, []);

  const installed = hello();
  state.deactivate();
  assert.equal(await state.hook.acceptCard(installed), false);
  assert.deepEqual(state.added, []);
  state.active = true;
  state.render();
  assert.equal(await state.hook.acceptCard(installed), true);
  assert.deepEqual(state.added, [installed]);
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.inputs, []);
});

test('an installed candidate stays queued while another addition scan is active', async () => {
  const state = mount();
  const scanning = state.hook.addCard();
  const installed = hello();
  assert.equal(await state.hook.acceptCard(installed), false);
  assert.deepEqual(state.added, []);
  state.scans[0].resolve();
  await scanning;
  state.render();
  assert.equal(await state.hook.acceptCard(installed), true);
  assert.deepEqual(state.added, [installed]);
});
