import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';

import * as actualMobx from 'mobx';

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
let rendering;
const owners = [];
const sameDependencies = (left, right) =>
  left?.length === right?.length &&
  left.every((value, index) => Object.is(value, right[index]));

function renderStep(props) {
  return {
    type: 'step',
    props: {
      ...props,
      children:
        props.numero === props.activeNumero ? props.children : undefined,
    },
  };
}

function element(type, props) {
  return type === renderStep ? renderStep(props) : {type, props};
}

mock.module('react', {
  namedExports: {
    useMemo(create, dependencies) {
      const slot = rendering.slot(() => ({}));
      if (!sameDependencies(slot.dependencies, dependencies)) {
        slot.dependencies = dependencies;
        slot.value = create();
      }
      return slot.value;
    },
    useCallback(callback, dependencies) {
      const slot = rendering.slot(() => ({}));
      if (!sameDependencies(slot.dependencies, dependencies)) {
        slot.dependencies = dependencies;
        slot.value = callback;
      }
      return slot.value;
    },
    useRef(initial) {
      return rendering.slot(() => ({current: initial}));
    },
    useState(initial) {
      const owner = rendering;
      const slot = owner.slot(() => ({
        value: typeof initial === 'function' ? initial() : initial,
      }));
      return [
        slot.value,
        value => {
          const next = typeof value === 'function' ? value(slot.value) : value;
          if (Object.is(next, slot.value)) return;
          slot.value = next;
          owner.dirty = true;
        },
      ];
    },
    useEffect(effect, dependencies) {
      const slot = rendering.slot(() => ({}));
      if (sameDependencies(slot.dependencies, dependencies)) return;
      rendering.effects.push(() => {
        slot.cleanup?.();
        slot.dependencies = dependencies;
        slot.effect = effect;
        slot.cleanup = effect();
      });
    },
  },
});
mock.module('mobx-react-lite', {
  namedExports: {observer: component => component},
});
mock.module('mobx', {
  namedExports: {
    ...actualMobx,
    reaction(expression, effect, options = {}) {
      const owner = fixture;
      let current = expression();
      const update = () => {
        const next = expression();
        if (Object.is(next, current)) return;
        current = next;
        effect(next);
      };
      owner.reactions.add(update);
      if (options.fireImmediately) effect(current);
      return () => owner.reactions.delete(update);
    },
  },
});
mock.module('react/jsx-runtime', {
  namedExports: {
    jsx: element,
    jsxs: element,
    Fragment: 'fragment',
  },
});
mock.module('lucide-react', {
  namedExports: {Info: 'info'},
});
mock.module('../.bld/app/@components/@ui/app-icon.js', {
  namedExports: {AppIcon: 'icon'},
});
mock.module('../.bld/app/@components/@ui/details-popup.js', {
  namedExports: {
    DetailsPopup: 'details-popup',
    DetailsPopupTitle: 'details-title',
    DetailsPopupDivider: 'details-divider',
  },
});
mock.module('../.bld/app/@components/@ui/confirm-popup.js', {
  namedExports: {ConfirmPopup: 'confirm-popup'},
});
mock.module('../.bld/app/@components/@ui/operation-complete.js', {
  namedExports: {OperationComplete: 'operation-complete'},
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => fixture.entrances},
});
mock.module('../.bld/app/@services/index.js', {
  namedExports: {
    isCredentialRequestCancelled: error => error?.code === 'CANCELLED',
  },
});
mock.module('../.bld/app/@components/@monoid/use-isodep-scan-prompt.js', {
  namedExports: {
    useIsoDepScanPrompt: () => (label, callback) => {
      fixture.scans.push(callback);
      fixture.events.push('scan');
      if (
        textOf(label).startsWith('Scan card ') ||
        ['Resetting card...', 'Checking card...'].includes(textOf(label)) ||
        find(
          fixture.tree,
          node => node.type === 'step' && node.props.activeNumero === 2,
        )
      ) {
        const scan = {
          ...deferred(),
          label,
          callback,
          controller: new AbortController(),
        };
        fixture.bundleScans.push(scan);
        return scan.promise;
      }
      fixture.scanCallback = callback;
      fixture.scanController = new AbortController();
      return fixture.scanFinished.promise;
    },
  },
});
mock.module('../.bld/app/@components/@monoid/monoid-scan-prompt.js', {
  namedExports: {
    MonoidScanStatePromptContentHighlight: 'highlight',
  },
});
mock.module('../.bld/app/@components/@monoid/card-preview.js', {
  namedExports: {
    CardGrid: 'card-grid',
    CardPlaceholder: 'card-placeholder',
    CardPreview: 'card-preview',
    CardPreviewButton: 'card-preview-button',
  },
});
mock.module('../.bld/app/@components/@ui/toggle.js', {
  namedExports: {Toggle: 'toggle'},
});
mock.module('../.bld/app/@components/@ui/toast.js', {
  namedExports: {useToast: () => message => fixture.toasts.push(message)},
});
mock.module('../.bld/app/@components/@ui/step.js', {
  namedExports: {Steps: 'steps', Step: renderStep},
});
mock.module('../.bld/app/@components/@ui/message-content.js', {
  namedExports: {WarningMessage: 'warning-message'},
});
mock.module('../.bld/app/@components/@ui/use-input-modal.js', {
  namedExports: {
    useInputModal: () => [
      null,
      (options, signal) => {
        const input = {...deferred(), options, signal};
        if (signal?.aborted) input.resolve(undefined);
        else
          signal?.addEventListener('abort', () => input.resolve(undefined), {
            once: true,
          });
        fixture.bundleInputs.push(input);
        return input.promise;
      },
    ],
  },
});
mock.module('../.bld/app/@components/@monoid/pin-input-placeholder.js', {
  namedExports: {
    PINKind: ({kind}) => kind,
    getPINInputPlaceholder: (kind, prefix = 'Enter') => ({
      placeholder: `${prefix} ${kind} PIN`,
    }),
  },
});
mock.module('../.bld/app/@components/@ui/button.js', {
  namedExports: {Button: 'button', Buttons: 'buttons'},
});
mock.module('../.bld/app/@components/@ui/info-section.js', {
  namedExports: {
    InfoPanel: 'panel',
    InfoSection: 'section',
    InfoSectionHeader: 'section-header',
    InfoSectionTitle: 'h2',
    InfoSectionItemLabel: 'label',
  },
});
mock.module('../.bld/app/@components/views/safe/@card/read-card-for-setup.js', {
  namedExports: {
    async readCardForSetup(sessionId, applet, _setState, signal) {
      fixture.setupReads.push({sessionId, applet});
      if (fixture.existingHello) {
        signal.throwIfAborted();
        return {type: 'ready', hello: fixture.existingHello};
      }
      fixture.reads.push(sessionId);
      const cardInformation = await (fixture.onRead
        ? fixture.onRead()
        : fixture.cardInformation);
      signal.throwIfAborted();
      return {type: 'setup', cardInformation};
    },
  },
});
mock.module('../.bld/app/@lib/global-platform/card-information.js', {
  namedExports: {
    async readCardInformation(sessionId) {
      fixture.reads.push(sessionId);
      return fixture.onRead ? fixture.onRead() : fixture.cardInformation;
    },
  },
});
mock.module(
  '../.bld/app/@components/views/safe/@card/card-information-popup.js',
  {
    namedExports: {CardInformationPopup: 'card-information-popup'},
  },
);
mock.module('../.bld/app/@components/views/safe/@card/card-setup-pin.js', {
  namedExports: {CardSetupPIN: 'card-setup-pin'},
});
const {useViewActive} = await import(
  '../.bld/app/@components/@view/use-view-active.js'
);
mock.module('../.bld/app/@components/@view/index.js', {
  namedExports: {
    View: 'view',
    ViewContent: 'content',
    ViewHeader: 'header',
    ViewHeaderButton: 'header-button',
    ViewHeaderTitle: 'h1',
    useViewActive,
  },
});

const {APPLET_NAMES, describeAppletInstallProgress} = await import(
  '../.bld/app/@lib/monoid/applet-install-progress.js'
);

test('upload percentage reaches 100 only after the final block is acknowledged', () => {
  assert.equal(
    describeAppletInstallProgress({
      stage: 'monoid',
      phase: 'uploading',
      progress: 299 / 300,
    }).percentage,
    99,
  );
  assert.equal(
    describeAppletInstallProgress({
      stage: 'monoid',
      phase: 'uploading',
      progress: 1,
    }).percentage,
    100,
  );
});
const install = async (sessionId, onProgress, signal) => {
  fixture.events.push('install');
  fixture.installs.push(sessionId);
  fixture.installSignals.push(signal);
  fixture.onProgress = onProgress;
  onProgress({stage: 'checking'});
  fixture.installStarted?.resolve();
  await fixture.installPending?.promise;
  if (fixture.installFailure) throw fixture.installFailure;
  fixture.bundleHello = fixture.hello;
  return fixture.hello;
};
mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {
    MonoidCardError,
    MonoidWrongCardError,
    MonoidAppletInvalidPINError,
    MonoidAppletHello,
    initializeMonoidCard,
    APPLET_NAMES,
    describeAppletInstallProgress,
    hasAppletBundle: true,
    installMonoidApplets: install,
  },
});
const {SetupCardView} = await import(
  '../.bld/app/@components/views/safe/@card/setup-card-view.js?ready'
);
const {CardBundleStore} = await import(
  '../.bld/app/@services/card-bundle-store.js'
);
const {CardBundleSession} = await import(
  '../.bld/app/@components/views/safe/@card/card-bundle-session.js'
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return {promise, resolve, reject};
}

function find(node, predicate) {
  if (node === null || node === undefined) return;
  if (predicate(node)) return node;
  const children = Array.isArray(node)
    ? node
    : [node.props?.children, node.props?.footer];
  for (const child of children) {
    const result = find(child, predicate);
    if (result) return result;
  }
}

function count(node, predicate) {
  if (node === null || node === undefined) return 0;
  const children = Array.isArray(node)
    ? node
    : [node.props?.children, node.props?.footer];
  return (
    Number(predicate(node)) +
    children.reduce((total, child) => total + count(child, predicate), 0)
  );
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node.type === 'function') return textOf(node.type(node.props));
  if (node.type === 'br') return '\n';
  return textOf(node.props?.children);
}

const CARD_INFORMATION = {
  cardManagerAid: 'a000000151000000',
  secureChannels: ['SCP03'],
  cplc: {
    icFabricator: '4790',
    icType: '1234',
    icSerialNumber: '01020304',
    operatingSystemId: '0001',
    operatingSystemReleaseDate: '2345',
    operatingSystemReleaseLevel: '0002',
  },
};

function initializedHello(hello) {
  return {
    ...hello,
    pins: {access: 5, secret: 5},
  };
}

const BUNDLE = new Uint8Array(32).fill(7);
const hex = value => Buffer.from(value).toString('hex');

function bundleCard(identity, overrides = {}) {
  return {
    version: 1,
    id: Uint8Array.of(0, 0, 0, identity),
    publicKey: Uint8Array.from([4, ...new Array(64).fill(identity)]),
    bundle: false,
    pins: {access: 5, secret: 5},
    ...overrides,
  };
}

async function enableBundle(state) {
  await find(state.render(), node => node.type === 'toggle').props.onChange(
    true,
  );
  state.render();
}

function preparedCard(hello) {
  return {
    id: hex(hello.id),
    publicKey: hex(hello.publicKey),
    bundle: hello.bundle === false ? false : hex(hello.bundle),
    items: [],
  };
}

async function roundTwo(identities = [1, 2]) {
  const state = mount(SetupCardView, {cardInformation: undefined});
  await enableBundle(state);
  state.members = identities.map(identity => bundleCard(identity));
  for (const card of state.members) {
    state.cachedCards.set(hex(card.publicKey), preparedCard(card));
    await state.collect(card);
  }
  await state.click('Continue');
  state.render();
  return state;
}

async function replacementCard() {
  const hello = bundleCard(1, {bundle: new Uint8Array(32).fill(9)});
  const source = preparedCard(hello);
  source.items.push({index: '0001', secret: true});
  const state = mount(
    SetupCardView,
    {
      cardInformation: undefined,
      card: {id: source.id, publicKey: source.publicKey},
      createBundle: true,
    },
    [source],
  );
  await state.finished;
  state.replacementHello = hello;
  state.replacementSource = source;
  return state;
}

function mount(
  Component = SetupCardView,
  viewOptions = {},
  cachedCards = [],
  bundleStore = new CardBundleStore(),
) {
  const state = {
    slots: [],
    reactions: new Set(),
    index: 0,
    errors: [],
    toasts: [],
    events: [],
    installs: [],
    installSignals: [],
    reads: [],
    scans: [],
    setupReads: [],
    bundleScans: [],
    bundleInputs: [],
    bundleCalls: [],
    credentialCalls: [],
    openedSessions: [],
    helloRequests: [],
    cachedCards: new Map(cachedCards.map(card => [card.publicKey, card])),
    cardLookups: [],
    routes: [],
    copyFlowLookups: [],
    copyAddAttempts: [],
    copyAdditions: [],
    backAvailable: true,
    backToCopyAvailable: false,
    backToCardAvailable: false,
    backToLookups: [],
    promptContents: [],
    cardInformation: structuredClone(CARD_INFORMATION),
    scanFinished: deferred(),
    hello: {
      version: 1,
      id: new Uint8Array([1, 2, 3, 4]),
      publicKey: new Uint8Array([4, ...new Uint8Array(64).fill(5)]),
      bundle: false,
      pins: {access: 5, secret: 5},
    },
    view: {
      $leaving: false,
      $match: {$exact: {$active: true}},
      bundleId: crypto.randomUUID(),
      cardInformation: undefined,
      ...viewOptions,
    },
    slot(create) {
      return (this.slots[this.index++] ??= create());
    },
    render() {
      fixture = state;
      let passes = 0;
      do {
        assert.ok(++passes < 20, 'Hook rerender loop');
        state.dirty = false;
        state.reactions.forEach(update => update());
        state.effects = [];
        rendering = state;
        state.index = 0;
        state.tree = Component({view: state.view});
        rendering = undefined;
        state.effects.forEach(effect => effect());
      } while (state.dirty);
      return state.tree;
    },
    replayEffects() {
      const effects = state.slots.filter(slot => slot.effect);
      effects.forEach(slot => slot.cleanup?.());
      effects.forEach(slot => {
        slot.cleanup = slot.effect();
      });
      state.render();
    },
    button(label) {
      return find(
        state.render(),
        node =>
          node.type === 'button' &&
          (label === undefined || textOf(node) === label),
      );
    },
    click(label) {
      const button = state.button(label);
      assert.ok(button, `Missing button: ${label}`);
      return button.props.onClick();
    },
    async startInstall(pin = 'New-42') {
      state.installationFinished = state.click();
      await state.answerBundlePIN(pin);
    },
    card(id) {
      return find(
        state.render(),
        node => node.type === 'card-preview' && node.props.id === id,
      );
    },
    cardButton(id) {
      return find(
        state.render(),
        node =>
          node.type === 'card-preview-button' &&
          node.props['aria-label']?.endsWith(` ${id}`),
      );
    },
    confirmation() {
      return find(state.render(), node => node.type === 'confirm-popup');
    },
    async confirmReplacement(popup = state.confirmation()) {
      assert.ok(popup, 'Expected bundle replacement confirmation');
      await popup.props.onConfirm();
      await state.finished;
      state.render();
    },
    async startReplacement(popup = state.confirmation()) {
      assert.ok(popup, 'Expected bundle replacement confirmation');
      await state.confirmReplacement(popup);
      if (
        !find(
          state.tree,
          node => node.type === 'step' && node.props.activeNumero === 2,
        )
      ) {
        await state.collect(bundleCard(2));
        await state.click('Continue');
      }
      state.replacementFinished = state
        .cardButton(hex(state.replacementHello.id))
        .props.onClick();
      await state.answerBundlePIN('New-42');
      state.render();
    },
    async prepareMember(hello) {
      const inputCount = state.bundleInputs.length;
      state.replacementFinished = state.click(
        state.button('Scan next card') ? 'Scan next card' : 'Scan a card',
      );
      for (let index = 0; index < 5; index++) await Promise.resolve();
      if (state.bundleInputs.length === inputCount) {
        await state.tapBundle(hello);
        assert.equal(state.bundleInputs.length, inputCount);
        state.bundleScans.at(-1).resolve();
        for (let index = 0; index < 10; index++) await Promise.resolve();
      }
      state.render();
    },
    async finishReplacement() {
      state.bundleScans.at(-1).resolve();
      await state.replacementFinished;
      state.render();
    },
    async retryReset(hello = state.replacementHello, pin = 'New-42') {
      await state.prepareMember(hello);
      if (!state.confirmation()) await state.answerBundlePIN(pin);
    },
    async collect(hello, rejection) {
      state.existingHello = hello;
      state.scanFinished = deferred();
      const add =
        state.button('Add a card') ?? state.button('Add another card');
      assert.ok(add, 'Expected a card collection button');
      add.props.onClick();
      if (rejection) {
        await assert.rejects(state.connect(), rejection);
      } else {
        await state.connect();
        state.scanFinished.resolve();
      }
      await state.finished;
      state.render();
    },
    async answerBundlePIN(...values) {
      const pin = values.length ? values[0] : 'Safe-42';
      state.bundleInputs.at(-1).resolve(pin);
      for (let index = 0; index < 10; index++) await Promise.resolve();
    },
    async tapBundle(hello) {
      const scan = state.bundleScans.at(-1);
      try {
        state.bundleHello = hello;
        await scan.callback(
          'bundle-session',
          content => state.promptContents.push(content),
          scan.controller.signal,
        );
      } catch (error) {
        if (!scan.deferFailure) scan.reject(error);
        throw error;
      }
    },
    async finishBundle() {
      state.bundleScans.at(-1).resolve();
      await state.finished;
      state.render();
    },
    async connect() {
      try {
        await state.scanCallback(
          'native-session',
          content => state.promptContents.push(content),
          state.scanController.signal,
        );
      } catch (error) {
        state.scanFinished.reject(error);
        throw error;
      }
    },
    unmount() {
      state.slots.splice(0).forEach(slot => slot.cleanup?.());
    },
  };
  const copyFlows = new Map(
    ['source-copy', 'other-copy'].map(copyId => [
      copyId,
      {
        session: {
          async addTarget(hello) {
            assert.notEqual(hello.pins.access, false);
            assert.notEqual(hello.pins.secret, false);
            assert.notEqual(hello.pins.access, 0);
            assert.notEqual(hello.pins.secret, 0);
            state.copyAddAttempts.push({copyId, hello});
            if (state.copyAddFailure) throw state.copyAddFailure;
            await state.copyAddPending?.promise;
            state.copyAdditions.push({copyId, hello});
          },
        },
      },
    ]),
  );
  state.view.$match.$view = () => ({$entries: [state.view]});
  state.pinSession = {
    async authenticate(signal) {
      state.events.push('vault-authenticate');
      state.credentialCalls.push({type: 'authenticate', signal});
      state.credentialStarted?.resolve();
      await state.credentialPending?.promise;
      if (state.credentialFailure) throw state.credentialFailure;
      signal?.throwIfAborted();
    },
    async removePIN(id, expectedPIN, signal) {
      state.events.push('remove-access-pin');
      state.credentialCalls.push({type: 'remove', id, expectedPIN, signal});
      state.removeStarted?.resolve();
      await state.removePending?.promise;
      if (state.removeFailure) throw state.removeFailure;
      signal?.throwIfAborted();
    },
    async setPIN(id, pin, signal) {
      state.events.push('save-access-pin');
      state.credentialCalls.push({type: 'save', id, pin, signal});
      await state.savePending?.promise;
      if (state.saveFailure) throw state.saveFailure;
      signal?.throwIfAborted();
    },
    clear() {
      state.credentialCalls.push({type: 'clear'});
    },
  };
  state.entrances = {
    cardBundleStore: bundleStore,
    monoidCredentialsStore: {
      createPINSession: () => state.pinSession,
    },
    monoidApplet: {
      async openSession(sessionId) {
        state.events.push('open-session');
        state.openedSessions.push(sessionId);
        return state.bundleApplet;
      },
    },
    cardStore: {
      set(card) {
        state.cachedCards.set(card.publicKey, card);
        return card;
      },
      get(identity) {
        state.cardLookups.push(identity);
        const card = state.cachedCards.get(identity.publicKey);
        return card?.id === identity.id ? card : undefined;
      },
    },
    copyItemsStore: {
      get(copyId) {
        state.copyFlowLookups.push(copyId);
        return copyFlows.get(copyId);
      },
    },
    router: {
      cardApplets: options => ({
        $push: () => state.routes.push({type: 'cardApplets', ...options}),
      }),
      $backTo: target => {
        state.backToLookups.push(target);
        if (target === state.entrances.router.safe.copyItems.$exact) {
          return state.backToCopyAvailable
            ? () => state.routes.push({type: 'back-to-copy'})
            : undefined;
        }
        if (target === state.entrances.router.safe.card.$exact) {
          return state.backToCardAvailable
            ? () => state.routes.push({type: 'back-to-card'})
            : undefined;
        }
        assert.equal(target, state.entrances.router.safe.$exact);
        return state.backAvailable
          ? () => state.routes.push({type: 'back-to-safe'})
          : undefined;
      },
      safe: {
        $exact: {},
        copyItems: {$exact: {}},
        card: {$exact: {}},
        scanCard: {$replace: () => state.routes.push({type: 'scan'})},
      },
    },
    errorService: {
      catch(promiseOrCallback) {
        if (promiseOrCallback instanceof Promise) {
          state.finished = promiseOrCallback.catch(error =>
            state.errors.push(error),
          );
          return;
        }
        return (...args) => {
          state.finished = Promise.resolve(promiseOrCallback(...args)).catch(
            error => state.errors.push(error),
          );
          return state.finished;
        };
      },
    },
  };
  state.bundleApplet = {
    async hello(request) {
      state.events.push('hello');
      state.helloRequests.push(request);
      return state.bundleHello;
    },
    async authenticate(request) {
      state.bundleCalls.push({type: 'authenticate', request});
      if (state.authFailure) throw state.authFailure;
    },
    async createBundle(request) {
      state.bundleCalls.push({type: 'create', request});
      state.createStarted?.resolve();
      await state.createPending?.promise;
      if (state.createFailure) throw state.createFailure;
      const keys = [...request.publicKeys].sort(Buffer.compare);
      const data = Uint8Array.from([
        1,
        keys.length >> 8,
        keys.length & 255,
        ...keys.flatMap(key => [...key]),
        ...new Array(113).fill(0),
      ]);
      return {
        bundle: BUNDLE,
        packets: request.publicKeys
          .filter(key => hex(key) !== hex(state.bundleHello.publicKey))
          .map(publicKey => ({publicKey, data})),
      };
    },
    async joinBundle(request) {
      state.bundleCalls.push({type: 'join', request});
      state.joinStarted?.resolve();
      await state.joinPending?.promise;
      if (state.joinFailure) throw state.joinFailure;
      return {bundle: BUNDLE};
    },
    async reset(request) {
      state.events.push('reset');
      state.bundleCalls.push({type: 'reset', request});
      state.resetStarted?.resolve();
      await state.resetPending?.promise;
      if (state.resetFailure) throw state.resetFailure;
      state.bundleHello = state.resetHello ?? {
        ...bundleCard(9),
        bundle: false,
        pins: {access: false, secret: false},
      };
      return {};
    },
    async setPIN(request) {
      state.events.push('set-pin');
      state.bundleCalls.push({type: 'set-pin', request});
      state.setPINStarted?.resolve();
      await state.setPINPending?.promise;
      if (state.setPINFailure) throw state.setPINFailure;
      state.bundleHello =
        state.initializedHello ?? initializedHello(state.bundleHello);
      return {};
    },
  };
  owners.push(state);
  state.render();
  return state;
}

afterEach(() => {
  owners.splice(0).forEach(owner => owner.unmount());
});

test('missing applets leave Setup after reader cleanup and carry the stable Bundle flow into Card maintenance', async () => {
  const state = mount(SetupCardView, {createBundle: true});
  const scanning = state.click('Add a card');
  await state.connect();
  assert.deepEqual(state.routes, []);
  assert.deepEqual(state.installs, []);
  state.scanFinished.resolve();
  await scanning;
  assert.deepEqual(state.routes, [
    {
      type: 'cardApplets',
      returnTo: 'bundle',
      bundleId: state.view.bundleId,
      cardInformation: state.cardInformation,
    },
  ]);
  assert.equal(
    count(state.render(), node => node.type === 'card-placeholder'),
    2,
  );
});

test('Card maintenance return survives a Setup remount without rereading or duplicating the first card', async () => {
  const source = preparedCard(bundleCard(1));
  const store = new CardBundleStore();
  const options = {bundleId: 'bundle-return', createBundle: true, card: source};
  const state = mount(SetupCardView, options, [source], store);
  await state.finished;
  state.unmount();
  await store.acceptInstalledCard(options.bundleId, bundleCard(2));
  const resumed = mount(SetupCardView, options, [source], store);
  await resumed.finished;
  assert.ok(resumed.card('00000001'));
  assert.ok(resumed.card('00000002'));
  assert.ok(resumed.button('Continue'));
  assert.equal(store.get(options.bundleId).session.cards.length, 2);
  assert.deepEqual(resumed.scans, []);
  assert.deepEqual(resumed.errors, []);
});

test('adding an initialized card does not cache unread resources as an empty card', async () => {
  const state = mount(SetupCardView, {createBundle: true});
  const hello = bundleCard(2);
  await state.collect(hello);
  assert.ok(state.card('00000002'));
  assert.equal(state.cachedCards.has(hex(hello.publicKey)), false);
});

test('an existing Bundle is reset and initialized during Add with one tap before its new identity is counted', async () => {
  const state = await replacementCard();
  const confirmation = state.confirmation();
  assert.deepEqual(confirmation.props.confirmText, [
    'I understand, add card',
    'Confirm',
  ]);
  const adding = confirmation.props.onConfirm();
  assert.equal(state.bundleInputs.at(-1).options.placeholder, 'Set Secret PIN');
  assert.deepEqual(state.scans, []);
  assert.equal(state.card('00000001'), undefined);
  await state.answerBundlePIN('New-42');
  assert.equal(state.scans.length, 1);
  await state.tapBundle(state.replacementHello);
  assert.deepEqual(
    state.bundleCalls.map(call => call.type),
    ['reset', 'set-pin', 'authenticate'],
  );
  assert.deepEqual(state.bundleCalls[1].request, {secret: true, pin: 'New-42'});
  assert.equal(state.card('00000009'), undefined);
  assert.equal(
    state.credentialCalls.some(call => call.type === 'save'),
    false,
  );
  assert.deepEqual(state.replacementSource.items, []);
  assert.equal(state.replacementSource.requiresPINSetup, true);
  state.bundleScans.at(-1).resolve();
  await adding;
  assert.equal(state.card('00000009').props.description, 'ready');
  assert.equal(state.card('00000001'), undefined);
  assert.equal(
    state.credentialCalls.filter(call => call.type === 'authenticate').length,
    1,
  );
  assert.equal(
    state.credentialCalls.find(call => call.type === 'remove').id,
    '00000001',
  );
  assert.equal(
    state.credentialCalls.find(call => call.type === 'save').id,
    '00000009',
  );
  assert.equal(
    state.cachedCards.get(hex(bundleCard(9).publicKey)).requiresPINSetup,
    false,
  );
  assert.deepEqual(state.errors, []);
});

test('cancelling the new Secret PIN prompt leaves the existing bundled card unchanged', async () => {
  const state = await replacementCard();
  const adding = state.confirmation().props.onConfirm();
  await state.answerBundlePIN(undefined);
  await adding;
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.bundleCalls, []);
  assert.equal(state.replacementSource.items.length, 1);
  assert.equal(state.card('00000001'), undefined);
  assert.equal(
    state.credentialCalls.some(call => call.type === 'authenticate'),
    false,
  );
});

test('a different physical identity is rejected before deleting its saved PIN or sending Reset', async () => {
  const state = await replacementCard();
  const adding = state.confirmation().props.onConfirm();
  await state.answerBundlePIN('New-42');
  await assert.rejects(
    state.tapBundle(bundleCard(2, {bundle: BUNDLE})),
    MonoidWrongCardError,
  );
  await adding;
  assert.deepEqual(state.bundleCalls, []);
  assert.equal(
    state.credentialCalls.some(call => call.type === 'remove'),
    false,
  );
  assert.equal(state.replacementSource.items.length, 1);
});

test('a lost initialization response resumes by reading the known new identity without replaying Reset or setPIN', async () => {
  const state = await replacementCard();
  state.setPINFailure = new Error('Response lost');
  const adding = state.confirmation().props.onConfirm();
  await state.answerBundlePIN('New-42');
  await assert.rejects(
    state.tapBundle(state.replacementHello),
    /Response lost/,
  );
  await adding;
  assert.ok(state.button('Check card'));
  const checking = state.click('Check card');
  const initialized = bundleCard(9);
  await state.tapBundle(initialized);
  state.bundleScans.at(-1).resolve();
  await checking;
  assert.equal(state.card('00000009').props.description, 'ready');
  assert.equal(
    state.bundleCalls.filter(call => call.type === 'reset').length,
    1,
  );
  assert.equal(
    state.bundleCalls.filter(call => call.type === 'set-pin').length,
    1,
  );
  assert.equal(state.bundleInputs.length, 1);
});

for (const destination of ['inactive', 'leaving', 'unmounted']) {
  test(`an acknowledged reset and PIN initialization remains in the Bundle when Setup becomes ${destination} during scan exit`, async () => {
    const state = await replacementCard();
    const flow = state.entrances.cardBundleStore.get(state.view.bundleId);
    const adding = state.confirmation().props.onConfirm();
    await state.answerBundlePIN('New-42');
    await state.tapBundle(state.replacementHello);
    assert.equal(flow.session.cards.length, 0);
    if (destination === 'unmounted') state.unmount();
    else {
      if (destination === 'inactive') state.view.$match.$exact.$active = false;
      else state.view.$leaving = true;
      state.render();
    }
    state.bundleScans.at(-1).resolve();
    await adding;
    assert.deepEqual(
      flow.session.cards.map(card => card.id),
      ['00000009'],
    );
    assert.equal(flow.pendingReset, undefined);
    assert.equal(
      state.bundleCalls.filter(call => call.type === 'reset').length,
      1,
    );
    assert.deepEqual(state.errors, []);
  });

  test(`a verified added card remains in the Bundle when Setup becomes ${destination} during scan exit`, async () => {
    const state = mount(SetupCardView, {createBundle: true});
    const flow = state.entrances.cardBundleStore.get(state.view.bundleId);
    state.existingHello = bundleCard(2);
    const adding = state.click('Add a card');
    await state.connect();
    assert.equal(flow.session.cards.length, 0);
    if (destination === 'unmounted') state.unmount();
    else {
      if (destination === 'inactive') state.view.$match.$exact.$active = false;
      else state.view.$leaving = true;
      state.render();
    }
    state.scanFinished.resolve();
    await adding;
    assert.deepEqual(
      flow.session.cards.map(card => card.id),
      ['00000002'],
    );
    assert.deepEqual(state.errors, []);
  });
}

test('normal Setup is plural with bundle creation off, while every Copy origin stays single-card', () => {
  const state = mount();
  assert.equal(
    textOf(find(state.tree, node => node.type === 'h1')),
    'Setup cards',
  );
  const toggle = find(state.tree, node => node.type === 'toggle');
  assert.equal(textOf(toggle), 'Create bundle');
  assert.equal(toggle.props.checked, false);
  assert.equal(toggle.props.disabled, false);

  for (const copyId of ['source-copy', 'missing-copy']) {
    const copy = mount(SetupCardView, {copyId});
    assert.equal(
      textOf(find(copy.tree, node => node.type === 'h1')),
      'Setup card',
    );
    assert.equal(
      find(copy.tree, node => node.type === 'toggle'),
      undefined,
    );
  }
});

test('Card entry adds the captured prepared card when enabling a bundle without another scan or fabricated PIN state', async () => {
  const source = preparedCard(bundleCard(1));
  const other = preparedCard(bundleCard(2));
  const identity = {id: source.id, publicKey: source.publicKey};
  const state = mount(
    SetupCardView,
    {cardInformation: undefined, card: identity},
    [source, other],
  );
  assert.equal(state.card(source.id), undefined);
  assert.equal(
    find(state.tree, node => node.type === 'toggle').props.checked,
    false,
  );
  assert.deepEqual(state.cardLookups, [identity]);
  state.view.card = {id: other.id, publicKey: other.publicKey};
  state.render();
  await enableBundle(state);
  assert.equal(state.card(source.id).props.description, 'ready');
  assert.equal(state.card(other.id), undefined);
  assert.equal(
    find(state.tree, node => node.type === 'toggle').props.disabled,
    true,
  );
  assert.equal(state.button('Continue'), undefined);
  assert.ok(state.button('Add another card'));
  assert.ok(
    state.cardLookups.every(
      ({id, publicKey}) =>
        id === identity.id && publicKey === identity.publicKey,
    ),
  );
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.helloRequests, []);
  assert.deepEqual(state.installs, []);
  assert.deepEqual(state.bundleCalls, []);
  assert.equal(
    find(state.tree, node => node.type === 'card-setup-pin'),
    undefined,
  );
  await state.collect(bundleCard(2));
  assert.ok(state.button('Continue'));
  assert.equal(state.card(source.id).props.description, 'ready');
  assert.equal(state.card(other.id).props.description, 'ready');
});

test('Card bundle entry starts enabled and adds the cached first card once across rerenders and effect replay', async () => {
  const source = preparedCard(bundleCard(1));
  const other = preparedCard(bundleCard(2));
  const identity = {id: source.id, publicKey: source.publicKey};
  const state = mount(
    SetupCardView,
    {cardInformation: undefined, card: identity, createBundle: true},
    [source, other],
  );
  assert.equal(
    find(state.tree, node => node.type === 'toggle'),
    undefined,
  );
  assert.equal(
    textOf(find(state.tree, node => node.type === 'h1')),
    'Setup card bundle',
  );
  state.replayEffects();
  await state.finished;
  assert.equal(state.card(source.id).props.description, 'ready');
  assert.ok(state.button('Add another card'));
  assert.equal(state.button('Continue'), undefined);
  assert.deepEqual(state.errors, []);

  state.view.card = {id: other.id, publicKey: other.publicKey};
  state.view.createBundle = false;
  state.render();
  state.replayEffects();
  await state.finished;
  assert.equal(
    find(state.render(), node => node.type === 'toggle'),
    undefined,
  );
  assert.equal(
    textOf(find(state.tree, node => node.type === 'h1')),
    'Setup card bundle',
  );
  assert.equal(state.card(source.id).props.description, 'ready');
  assert.equal(state.card(other.id), undefined);
  assert.ok(
    state.cardLookups.every(
      ({id, publicKey}) =>
        id === identity.id && publicKey === identity.publicKey,
    ),
  );
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.helloRequests, []);
  assert.deepEqual(state.installs, []);
  assert.deepEqual(state.bundleCalls, []);
  assert.deepEqual(state.errors, []);

  state.cardButton(source.id).props.onClick();
  await state.click('Remove');
  state.replayEffects();
  await state.finished;
  assert.equal(state.card(source.id), undefined);
  assert.ok(state.button('Add a card'));
  assert.deepEqual(state.errors, []);
});

test('Card bundle entry waits for the entering route to become active before adding its cached card once', async context => {
  const add = context.mock.method(
    CardBundleSession.prototype,
    'addPreparedCard',
  );
  const source = preparedCard(bundleCard(1));
  const state = mount(
    SetupCardView,
    {
      cardInformation: undefined,
      card: {id: source.id, publicKey: source.publicKey},
      createBundle: true,
      $match: {$exact: {$active: false, $transition: true}},
    },
    [source],
  );
  state.replayEffects();
  await state.finished;
  assert.equal(add.mock.callCount(), 0);
  assert.equal(state.card(source.id), undefined);
  assert.equal(state.confirmation(), undefined);
  assert.deepEqual(state.scans, []);

  state.view.$match.$exact.$active = true;
  state.view.$match.$exact.$transition = false;
  state.render();
  await state.finished;
  assert.equal(add.mock.callCount(), 1);
  assert.equal(state.card(source.id).props.description, 'ready');
  assert.ok(state.button('Add another card'));
  state.replayEffects();
  state.view.$match.$exact.$active = false;
  state.render();
  state.view.$match.$exact.$active = true;
  state.render();
  await state.finished;
  assert.equal(add.mock.callCount(), 1);
  assert.equal(state.card(source.id).props.description, 'ready');
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.errors, []);
});

for (const destination of ['leaving', 'unmounted']) {
  test(`an entering Card bundle route does not prefill after becoming ${destination}`, async context => {
    const add = context.mock.method(
      CardBundleSession.prototype,
      'addPreparedCard',
    );
    const source = preparedCard(bundleCard(1));
    const state = mount(
      SetupCardView,
      {
        cardInformation: undefined,
        card: {id: source.id, publicKey: source.publicKey},
        createBundle: true,
        $match: {$exact: {$active: false, $transition: true}},
      },
      [source],
    );
    if (destination === 'leaving') state.view.$leaving = true;
    else state.unmount();
    state.view.$match.$exact.$active = true;
    state.view.$match.$exact.$transition = false;
    if (destination === 'leaving') state.render();
    else state.reactions.forEach(update => update());
    await state.finished;
    assert.equal(add.mock.callCount(), 0);
    assert.equal(
      find(state.tree, node => node.type === 'card-preview'),
      undefined,
    );
    assert.equal(
      find(state.tree, node => node.type === 'confirm-popup'),
      undefined,
    );
    assert.deepEqual(state.scans, []);
    assert.deepEqual(state.bundleCalls, []);
    assert.deepEqual(state.errors, []);
  });
}

test('automatic bundle entry with no cached Card keeps bundle mode on and starts empty', async () => {
  const source = preparedCard(bundleCard(1));
  const state = mount(SetupCardView, {
    cardInformation: undefined,
    card: {id: source.id, publicKey: source.publicKey},
    createBundle: true,
  });
  await state.finished;
  assert.equal(
    find(state.render(), node => node.type === 'toggle'),
    undefined,
  );
  assert.equal(
    textOf(find(state.tree, node => node.type === 'h1')),
    'Setup card bundle',
  );
  assert.equal(state.card(source.id), undefined);
  assert.ok(state.button('Add a card'));
  assert.equal(state.button('Continue'), undefined);
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.errors, []);
});

test('Copy entry ignores bundle mode and source Card identity and retains its single-card destination flow', async () => {
  const source = preparedCard(bundleCard(1));
  const state = mount(
    SetupCardView,
    {
      cardInformation: undefined,
      card: {id: source.id, publicKey: source.publicKey},
      copyId: 'source-copy',
      createBundle: true,
    },
    [source],
  );
  state.backToCopyAvailable = true;
  state.backToCardAvailable = true;
  assert.deepEqual(state.cardLookups, []);
  assert.equal(
    textOf(find(state.tree, node => node.type === 'h1')),
    'Setup card',
  );
  assert.equal(
    find(state.tree, node => node.type === 'toggle'),
    undefined,
  );
  const destination = bundleCard(2);
  await state.collect(destination);
  assert.deepEqual(state.copyAdditions, [
    {copyId: 'source-copy', hello: destination},
  ]);
  assert.ok(find(state.tree, node => node.type === 'operation-complete'));
  assert.deepEqual(state.cardLookups, [
    {id: hex(destination.id), publicKey: hex(destination.publicKey)},
  ]);
  assert.deepEqual(state.bundleCalls, []);
  assert.equal(state.button('Back to Card'), undefined);
  assert.equal(state.button('Back to Safe'), undefined);
  assert.equal(state.button('Back to Copy').props.color, 'neutral');
  await state.click('Back to Copy');
  assert.deepEqual(state.routes, [{type: 'back-to-copy'}]);
  assert.ok(
    !state.backToLookups.includes(state.entrances.router.safe.card.$exact),
  );
});

test('an existing initialized applet completes directly without GP information or installation', async () => {
  const state = mount(SetupCardView, {cardInformation: undefined});
  await state.collect(bundleCard(1));
  assert.equal(state.setupReads.length, 1);
  assert.equal(state.setupReads[0].applet, state.entrances.monoidApplet);
  assert.deepEqual(state.reads, []);
  assert.deepEqual(state.installs, []);
  assert.equal(
    find(state.tree, node => node.type === 'card-setup-pin'),
    undefined,
  );
  assert.ok(find(state.tree, node => node.type === 'operation-complete'));
  assert.deepEqual(state.routes, []);
});

test('bundle collection waits for scan cleanup and PIN setup before counting the card', async () => {
  const state = mount(SetupCardView, {cardInformation: undefined});
  await enableBundle(state);
  assert.equal(state.button('Continue'), undefined);
  assert.equal(state.button('Add a card').props.color, 'primary');
  const initialFooter = find(state.tree, node => node.type === 'content').props
    .footer;
  assert.deepEqual(initialFooter.props.children.filter(Boolean).map(textOf), [
    'Add a card',
  ]);
  state.existingHello = bundleCard(1, {pins: {access: false, secret: false}});
  state.click('Add a card');
  await state.connect();
  assert.equal(state.card('00000001'), undefined);
  assert.equal(
    find(state.tree, node => node.type === 'card-setup-pin'),
    undefined,
  );
  state.scanFinished.resolve();
  await state.finished;
  const setup = find(state.render(), node => node.type === 'card-setup-pin');
  assert.ok(setup);
  assert.equal(state.card('00000001'), undefined);
  assert.equal(state.button('Continue'), undefined);
  await setup.props.onFinished(true, initializedHello(state.existingHello));

  assert.equal(state.card('00000001').props.description, 'ready');
  assert.equal(
    find(state.tree, node => node.type === 'operation-complete'),
    undefined,
  );
  assert.equal(state.button('Continue'), undefined);
  assert.equal(
    find(state.tree, node => node.type === 'toggle').props.disabled,
    true,
  );
  await state.collect(bundleCard(2));
  assert.ok(state.button('Continue'));
  const readyFooter = find(state.tree, node => node.type === 'content').props
    .footer;
  assert.deepEqual(
    readyFooter.props.children
      .filter(Boolean)
      .map(button => [textOf(button), button.props.color]),
    [
      ['Continue', 'primary'],
      ['Add another card', 'neutral'],
    ],
  );
  assert.deepEqual(state.installs, []);
});

test('collected members can be removed before round two, which locks membership', async () => {
  const state = mount(SetupCardView, {cardInformation: undefined});
  await enableBundle(state);
  await state.collect(bundleCard(1));
  await state.collect(bundleCard(2));
  const collectingSteps = [1, 2].map(numero =>
    find(
      state.render(),
      node => node.type === 'step' && node.props.numero === numero,
    ),
  );
  assert.deepEqual(
    collectingSteps.map(step => [
      textOf(step.props.title),
      step.props.numero,
      step.props.activeNumero,
    ]),
    [
      ['Add cards', 1, 1],
      ['Create bundle', 2, 1],
    ],
  );
  assert.equal(
    count(state.tree, node => node.type === 'card-grid'),
    1,
  );
  assert.ok(find(collectingSteps[0], node => node.type === 'card-grid'));
  assert.equal(
    find(collectingSteps[1], node => node.type === 'card-grid'),
    undefined,
  );
  state.cardButton('00000001').props.onClick();
  assert.ok(find(state.render(), node => node.type === 'details-popup'));
  await state.click('Remove');
  assert.equal(state.card('00000001'), undefined);
  assert.equal(state.button('Continue'), undefined);
  await state.collect(bundleCard(3));
  await state.click('Continue');
  const configuringSteps = [1, 2].map(numero =>
    find(
      state.render(),
      node => node.type === 'step' && node.props.numero === numero,
    ),
  );
  assert.deepEqual(
    configuringSteps.map(step => step.props.activeNumero),
    [2, 2],
  );
  assert.equal(
    count(state.tree, node => node.type === 'card-grid'),
    1,
  );
  assert.equal(
    find(configuringSteps[0], node => node.type === 'card-grid'),
    undefined,
  );
  assert.ok(find(configuringSteps[1], node => node.type === 'card-grid'));
  assert.equal(
    find(state.render(), node => node === 'Scan each card again to finish'),
    undefined,
  );
  assert.equal(
    find(state.tree, node => node.type === 'toggle').props.disabled,
    true,
  );
  assert.equal(
    find(state.tree, node => node.props?.['aria-label'] === 'Add card'),
    undefined,
  );
  assert.equal(state.card('00000002').props.description, 'pending');
  state.cardButton('00000003').props.onClick();
  assert.equal(
    find(state.render(), node => node.type === 'details-popup'),
    undefined,
  );
  assert.equal(state.bundleInputs.length, 1);
  await state.answerBundlePIN(undefined);
  await state.finished;
});

test('two-round setup authenticates each member and completes only after the final scan closes', async () => {
  const state = await roundTwo();
  const firstClick = state.button('Scan a card').props.onClick;
  const configuring = firstClick();
  await firstClick();
  assert.equal(state.bundleInputs.length, 1);
  assert.equal(state.bundleInputs[0].options.placeholder, 'Enter Secret PIN');
  assert.equal(
    textOf(state.bundleInputs[0].options.description),
    'For the card you will scan',
  );
  await state.answerBundlePIN();
  assert.equal(textOf(state.bundleScans[0].label), 'Scan a card');
  await state.tapBundle(state.members[0]);
  assert.equal(state.card('00000001').props.description, 'complete');
  assert.equal(state.card('00000002').props.description, 'pending');
  assert.equal(
    state.cachedCards.get(hex(state.members[0].publicKey)).bundle,
    hex(BUNDLE),
  );
  assert.equal(
    state.cachedCards.get(hex(state.members[1].publicKey)).bundle,
    false,
  );
  state.bundleScans[0].resolve();
  await configuring;
  state.click('Scan next card');
  await state.answerBundlePIN('Other-42');
  assert.equal(textOf(state.bundleScans.at(-1).label), 'Scan next card');
  await state.tapBundle(state.members[1]);

  assert.equal(
    find(state.render(), node => node.type === 'operation-complete'),
    undefined,
  );
  assert.equal(state.button('Back to Safe'), undefined);
  assert.equal(
    state.cachedCards.get(hex(state.members[1].publicKey)).bundle,
    hex(BUNDLE),
  );
  await state.finishBundle();
  assert.ok(find(state.tree, node => node.type === 'operation-complete'));
  assert.equal(
    find(state.tree, node => node.type === 'steps'),
    undefined,
  );
  assert.equal(state.button('Back to Safe').props.color, 'neutral');
  assert.deepEqual(
    state.bundleCalls.map(call => call.type),
    ['authenticate', 'create', 'authenticate', 'join'],
  );
  assert.deepEqual(
    state.bundleCalls
      .filter(call => call.type === 'authenticate')
      .map(call => call.request),
    [
      {secret: true, pin: 'Safe-42'},
      {secret: true, pin: 'Other-42'},
    ],
  );
  assert.deepEqual(state.routes, []);
  state.click('Back to Safe');
  assert.deepEqual(state.routes, [{type: 'back-to-safe'}]);
  assert.equal(state.bundleScans.length, 2);
  assert.deepEqual(state.openedSessions, ['bundle-session', 'bundle-session']);
  assert.deepEqual(state.helloRequests, [{}, {}]);
});

for (const outcome of ['complete', 'uncertain']) {
  test(`Card-origin bundle ${outcome} returns to Card without selecting an unrelated Copy history entry`, async () => {
    const members = [bundleCard(1), bundleCard(2)];
    const source = preparedCard(members[0]);
    const state = mount(
      SetupCardView,
      {
        card: {id: source.id, publicKey: source.publicKey},
        createBundle: true,
      },
      [source],
    );
    state.backToCardAvailable = true;
    state.backToCopyAvailable = true;
    await state.finished;
    await state.collect(members[1]);
    await state.click('Continue');

    state.click('Scan a card');
    await state.answerBundlePIN();
    if (outcome === 'uncertain') {
      state.createFailure = new Error('Response lost');
      await assert.rejects(
        state.tapBundle(members[0]),
        /Bundle creation not confirmed/,
      );
      await state.finished;
    } else {
      await state.tapBundle(members[0]);
      await state.finishBundle();
      state.click('Scan next card');
      await state.answerBundlePIN();
      await state.tapBundle(members[1]);
      await state.finishBundle();
    }

    assert.equal(state.button('Back to Card').props.color, 'neutral');
    assert.equal(state.button('Back to Copy'), undefined);
    assert.equal(state.button('Back to Safe'), undefined);
    assert.ok(
      !state.backToLookups.includes(
        state.entrances.router.safe.copyItems.$exact,
      ),
    );
    await state.click('Back to Card');
    assert.deepEqual(state.routes, [{type: 'back-to-card'}]);
  });
}

for (const canBackToSafe of [true, false]) {
  test(`Card-origin setup without Card history ${canBackToSafe ? 'falls back to Safe' : 'hides the return button when no return exists'}`, async () => {
    const card = bundleCard(1);
    const source = preparedCard(card);
    const state = mount(
      SetupCardView,
      {card: {id: source.id, publicKey: source.publicKey}},
      [source],
    );
    state.backAvailable = canBackToSafe;
    state.backToCopyAvailable = true;
    await state.collect(card);

    assert.ok(find(state.tree, node => node.type === 'operation-complete'));
    assert.equal(state.button('Back to Card'), undefined);
    assert.equal(state.button('Back to Copy'), undefined);
    if (canBackToSafe) {
      await state.click('Back to Safe');
      assert.deepEqual(state.routes, [{type: 'back-to-safe'}]);
    } else {
      assert.equal(state.button('Back to Safe'), undefined);
      assert.deepEqual(state.routes, []);
    }
  });
}

test('cancelling the round-two PIN prompt restores the button without starting a scan', async () => {
  const state = await roundTwo();
  state.click('Scan a card');
  await state.answerBundlePIN(undefined);
  await state.finished;
  assert.equal(state.button('Scan a card').props.loading, false);
  assert.equal(state.card('00000001').props.description, 'pending');
  assert.deepEqual(state.bundleScans, []);
  assert.deepEqual(state.bundleCalls, []);
  state.click('Scan a card');
  assert.equal(state.bundleInputs.length, 2);
  await state.answerBundlePIN(undefined);
  await state.finished;
});

for (const destination of ['leaving', 'inactive', 'unmounted']) {
  test(`late round-two PIN input does not start a scan after Setup becomes ${destination}`, async () => {
    const state = await roundTwo();
    state.click('Scan a card');
    if (destination === 'leaving') state.view.$leaving = true;
    if (destination === 'inactive') state.view.$match.$exact.$active = false;
    if (destination === 'unmounted') state.unmount();
    else state.render();
    await state.answerBundlePIN();
    await state.finished;
    assert.deepEqual(state.bundleScans, []);
    assert.deepEqual(state.bundleCalls, []);
    assert.deepEqual(state.errors, []);
  });
}

test('selecting a specific card still rejects another member before authentication without marking either interrupted', async () => {
  const state = await roundTwo();
  state.cardButton('00000001').props.onClick();
  assert.equal(
    textOf(state.bundleInputs[0].options.description),
    'Card 00000001',
  );
  await state.answerBundlePIN();
  assert.equal(textOf(state.bundleScans[0].label), 'Scan card 00000001');
  await assert.rejects(state.tapBundle(state.members[1]), /Wrong card/);
  await state.finished;
  assert.deepEqual(state.bundleCalls, []);
  assert.equal(state.card('00000001').props.description, 'pending');
  assert.equal(state.card('00000002').props.description, 'pending');
  assert.equal(state.button('Scan a card').props.loading, false);
  state.click('Scan a card');
  await state.answerBundlePIN();
  await state.tapBundle(state.members[0]);
  await state.finishBundle();
  assert.equal(state.card('00000001').props.description, 'complete');
  assert.equal(
    state.bundleCalls.filter(call => call.type === 'create').length,
    1,
  );
});

test('the generic round-two button configures three members in any order without selecting cards', async () => {
  const state = await roundTwo([1, 2, 3]);
  const completed = new Set();
  for (const identity of [2, 3, 1]) {
    const scanLabel = completed.size ? 'Scan next card' : 'Scan a card';
    state.click(scanLabel);
    assert.equal(
      textOf(state.bundleInputs.at(-1).options.description),
      'For the card you will scan',
    );
    await state.answerBundlePIN(`Safe-${identity}`);
    assert.equal(textOf(state.bundleScans.at(-1).label), scanLabel);
    await state.tapBundle(state.members[identity - 1]);
    completed.add(identity);
    for (const member of [1, 2, 3]) {
      const card = state.members[member - 1];
      assert.equal(
        state.card(hex(card.id)).props.description,
        completed.has(member) ? 'complete' : 'pending',
      );
      assert.equal(
        state.cachedCards.get(hex(card.publicKey)).bundle,
        completed.has(member) ? hex(BUNDLE) : false,
      );
    }
    assert.equal(
      find(state.tree, node => node.type === 'operation-complete'),
      undefined,
    );
    await state.finishBundle();
  }
  assert.ok(find(state.tree, node => node.type === 'operation-complete'));
  assert.deepEqual(
    state.bundleCalls.map(call => call.type),
    ['authenticate', 'create', 'authenticate', 'join', 'authenticate', 'join'],
  );
  for (const call of state.bundleCalls.filter(call => call.type === 'join')) {
    assert.deepEqual(call.request.senderPublicKey, state.members[1].publicKey);
  }
  assert.deepEqual(state.routes, []);
});

for (const mismatch of [
  'non-member',
  'same ID with different public key',
  'same public key with different ID',
]) {
  test(`the generic round-two button rejects ${mismatch} before authentication without marking a member interrupted`, async () => {
    const state = await roundTwo();
    const hello =
      mismatch === 'same ID with different public key'
        ? bundleCard(9, {id: state.members[0].id})
        : mismatch === 'same public key with different ID'
          ? bundleCard(9, {publicKey: state.members[0].publicKey})
          : bundleCard(9);
    state.click('Scan a card');
    await state.answerBundlePIN();
    await assert.rejects(
      state.tapBundle(hello),
      /Scan one of the added cards|Wrong card/,
    );
    await state.finished;
    assert.deepEqual(state.bundleCalls, []);
    assert.equal(state.card('00000001').props.description, 'pending');
    assert.equal(state.card('00000002').props.description, 'pending');
    assert.equal(state.button('Scan a card').props.loading, false);
    state.click('Scan a card');
    await state.answerBundlePIN();
    await state.tapBundle(state.members[1]);
    await state.finishBundle();
    assert.equal(state.card('00000002').props.description, 'complete');
    assert.equal(state.card('00000001').props.description, 'pending');
  });
}

test('the generic round-two button rejects an already completed member without reauthenticating', async () => {
  const state = await roundTwo();
  state.click('Scan a card');
  await state.answerBundlePIN();
  await state.tapBundle(state.members[1]);
  await state.finishBundle();
  const calls = [...state.bundleCalls];
  state.click('Scan next card');
  await state.answerBundlePIN();
  await assert.rejects(
    state.tapBundle({...state.members[1], bundle: BUNDLE}),
    /already configured/,
  );
  await state.finished;
  assert.deepEqual(state.bundleCalls, calls);
  assert.equal(state.card('00000001').props.description, 'pending');
  assert.equal(state.card('00000002').props.description, 'complete');
  assert.equal(state.button('Scan next card').props.loading, false);
  state.click('Scan next card');
  await state.answerBundlePIN();
  await state.tapBundle(state.members[0]);
  await state.finishBundle();
  assert.ok(find(state.tree, node => node.type === 'operation-complete'));
});

test('an uncertain create result cannot be retried or reconfigure another member', async () => {
  const state = await roundTwo();
  state.createFailure = new Error('Response lost');
  state.click('Scan a card');
  await state.answerBundlePIN();
  await assert.rejects(
    state.tapBundle(state.members[0]),
    /Bundle creation not confirmed/,
  );
  await state.finished;
  assert.ok(find(state.render(), node => node.props?.role === 'alert'));
  assert.equal(state.button('Scan a card'), undefined);
  assert.equal(state.cardButton('00000002').props.disabled, true);
  assert.ok(state.button('Back to Safe'));
  assert.equal(
    find(state.tree, node => node.type === 'operation-complete'),
    undefined,
  );
  assert.deepEqual(state.routes, []);
  assert.equal(
    state.bundleCalls.filter(call => call.type === 'create').length,
    1,
  );
});

test('cancelling an enrolled-card confirmation invalidates late approval and leaves collection usable', async context => {
  const add = context.mock.method(CardBundleSession.prototype, 'addCard');
  const state = mount(SetupCardView, {cardInformation: undefined});
  await enableBundle(state);
  state.existingHello = bundleCard(1, {bundle: BUNDLE});
  state.click('Add a card');
  await state.connect();
  assert.equal(state.confirmation(), undefined);
  state.scanFinished.resolve();
  await state.finished;
  const popup = state.confirmation();
  assert.ok(popup);
  assert.equal(add.mock.callCount(), 0);
  assert.equal(state.button('Add a card').props.disabled, true);
  assert.equal(state.button('Continue'), undefined);
  const scanCount = state.scans.length;
  await state.click('Add a card');
  assert.equal(state.scans.length, scanCount);
  popup.props.onCancel();
  assert.equal(state.confirmation(), undefined);
  await state.confirmReplacement(popup);
  assert.equal(add.mock.callCount(), 0);
  assert.equal(state.card('00000001'), undefined);
  assert.deepEqual(state.bundleCalls, []);
  assert.deepEqual(state.errors, []);
  await state.collect(bundleCard(2));
  assert.equal(state.card('00000002').props.description, 'ready');
});

for (const destination of ['leaving', 'inactive', 'unmounted']) {
  test(`an enrolled-card confirmation cannot add late after Setup is ${destination}`, async context => {
    const add = context.mock.method(CardBundleSession.prototype, 'addCard');
    const state = mount(SetupCardView, {cardInformation: undefined});
    await enableBundle(state);
    await state.collect(bundleCard(1, {bundle: BUNDLE}));
    const popup = state.confirmation();
    assert.ok(popup);
    if (destination === 'leaving') state.view.$leaving = true;
    if (destination === 'inactive') state.view.$match.$exact.$active = false;
    if (destination === 'unmounted') state.unmount();
    else {
      assert.equal(state.confirmation(), undefined);
      state.view.$leaving = false;
      state.view.$match.$exact.$active = true;
      assert.equal(state.confirmation(), undefined);
    }
    await popup.props.onConfirm();
    await state.finished;
    assert.equal(add.mock.callCount(), 0);
    assert.deepEqual(state.bundleCalls, []);
    assert.deepEqual(state.errors, []);
    if (destination !== 'unmounted') {
      assert.equal(state.card('00000001'), undefined);
      await state.collect(bundleCard(2));
      assert.equal(state.card('00000002').props.description, 'ready');
    }
  });
}

test('a duplicate card rejects the live scan before returning to collection', async () => {
  const state = mount(SetupCardView, {cardInformation: undefined});
  await enableBundle(state);
  await state.collect(bundleCard(1));
  await state.collect(bundleCard(1), /already added/);
  assert.match(state.errors[0].message, /already added/);
  assert.equal(state.card('00000001').props.description, 'ready');
  assert.equal(state.button('Continue'), undefined);
  assert.ok(state.button('Add another card'));
  assert.equal(state.button('Skip card'), undefined);
  await state.collect(bundleCard(2));
  assert.ok(state.button('Continue'));
  assert.equal(state.card('00000002').props.description, 'ready');
});

test('a full bundle rejects a new card while the scan is still open', async () => {
  const state = mount(SetupCardView, {cardInformation: undefined});
  await enableBundle(state);
  const session = state.entrances.cardBundleStore.get(
    state.view.bundleId,
  ).session;
  for (let identity = 1; identity <= 122; identity++) {
    await session.addCard(bundleCard(identity));
  }
  await state.collect(bundleCard(123), /Too many cards/);
  assert.equal(session.cards.length, 122);
  assert.equal(state.card('0000007b'), undefined);
  assert.equal(state.confirmation(), undefined);
});

for (const kind of ['access', 'secret']) {
  test(`a blocked ${kind} PIN rejects the live scan and leaves collection ready`, async () => {
    const state = mount(SetupCardView, {cardInformation: undefined});
    await enableBundle(state);
    await state.collect(
      bundleCard(1, {pins: {access: 5, secret: 5, [kind]: 0}}),
      /PIN blocked/,
    );
    assert.equal(state.card('00000001'), undefined);
    assert.match(state.errors[0].message, /PIN blocked/);
    assert.equal(
      find(state.tree, node => node.type === 'card-setup-pin'),
      undefined,
    );
    assert.ok(state.button('Add a card'));
    assert.equal(state.button('Skip card'), undefined);
    await state.collect(bundleCard(2));
    assert.equal(state.card('00000002').props.description, 'ready');
    assert.equal(state.button('Continue'), undefined);
  });

  test(`an enrolled card with blocked ${kind} PIN still hands off to reset after scan cleanup`, async () => {
    const state = mount(SetupCardView, {cardInformation: undefined});
    await enableBundle(state);
    state.existingHello = bundleCard(1, {
      bundle: BUNDLE,
      pins: {access: 5, secret: 5, [kind]: 0},
    });
    state.click('Add a card');
    await state.connect();
    assert.equal(state.confirmation(), undefined);
    state.scanFinished.resolve();
    await state.finished;
    assert.ok(state.confirmation());
    assert.deepEqual(state.errors, []);
    assert.equal(state.card('00000001'), undefined);
  });
}

test('creating a bundle waits for acknowledgement without prematurely showing failure or a return button', async () => {
  const state = await roundTwo();
  state.createStarted = deferred();
  state.createPending = deferred();
  state.click('Scan a card');
  await state.answerBundlePIN();
  const tapping = state.tapBundle(state.members[0]);
  await state.createStarted.promise;
  assert.equal(
    find(state.render(), node => node.props?.role === 'alert'),
    undefined,
  );
  assert.equal(state.button('Back to Safe'), undefined);
  assert.equal(state.button('Scan a card').props.loading, true);
  assert.equal(state.card('00000001').props.description, 'pending');
  assert.equal(
    find(state.tree, node => node.type === 'operation-complete'),
    undefined,
  );
  state.createPending.resolve();
  await tapping;
  await state.finishBundle();
  assert.equal(state.card('00000001').props.description, 'complete');
  assert.ok(state.button('Scan next card'));
  assert.deepEqual(state.errors, []);
});

test('a join error keeps the acknowledged creator and retries only the pending member', async () => {
  const state = await roundTwo();
  state.click('Scan a card');
  await state.answerBundlePIN();
  await state.tapBundle(state.members[0]);
  await state.finishBundle();
  state.joinFailure = new Error('Connection lost');
  state.click('Scan next card');
  await state.answerBundlePIN();
  await assert.rejects(state.tapBundle(state.members[1]), /Connection lost/);
  await state.finished;
  assert.equal(state.card('00000001').props.description, 'complete');
  assert.equal(state.cardButton('00000001').props.disabled, true);
  assert.equal(state.card('00000002').props.description, 'interrupted');
  assert.equal(
    state.cachedCards.get(hex(state.members[1].publicKey)).bundle,
    false,
  );
  state.joinFailure = undefined;
  state.click('Scan next card');
  await state.answerBundlePIN();
  await state.tapBundle(state.members[1]);
  await state.finishBundle();
  assert.ok(find(state.tree, node => node.type === 'operation-complete'));
  assert.equal(
    state.bundleCalls.filter(call => call.type === 'create').length,
    1,
  );
  assert.equal(
    state.bundleCalls.filter(call => call.type === 'join').length,
    2,
  );
});

test('cancelling an in-flight join keeps the late ACK and prevents another operation until cleanup', async () => {
  const state = await roundTwo();
  state.click('Scan a card');
  await state.answerBundlePIN();
  await state.tapBundle(state.members[0]);
  await state.finishBundle();

  state.joinStarted = deferred();
  state.joinPending = deferred();
  const click = state.button('Scan next card').props.onClick;
  const configuring = click();
  await state.answerBundlePIN();
  const scan = state.bundleScans.at(-1);
  scan.deferFailure = true;
  const tapping = state.tapBundle(state.members[1]);
  await state.joinStarted.promise;
  const cancellation = Object.assign(new Error('Card scanning was cancelled'), {
    code: 'CANCELLED',
  });
  scan.controller.abort(cancellation);
  assert.equal(state.button('Scan next card').props.loading, true);
  await click();
  assert.equal(state.bundleInputs.length, 2);
  state.joinPending.resolve();
  await assert.rejects(tapping, /cancelled/);

  assert.equal(state.card('00000002').props.description, 'complete');
  assert.equal(
    state.cachedCards.get(hex(state.members[1].publicKey)).bundle,
    hex(BUNDLE),
  );
  assert.equal(
    find(state.tree, node => node.type === 'operation-complete'),
    undefined,
  );
  assert.equal(state.button('Back to Safe'), undefined);
  scan.reject(cancellation);
  await configuring;
  assert.ok(find(state.render(), node => node.type === 'operation-complete'));
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.routes, []);
  assert.equal(
    state.bundleCalls.filter(call => call.type === 'join').length,
    1,
  );
});
