import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

import {parseSSHAccount} from '@monoid/ssh-protocol';

let state;
mock.module('react', {
  namedExports: {
    useRef: value => ({current: value}),
    useEffect: () => {},
    useState: initial => {
      const index = state.cursor++;
      if (!(index in state.hooks))
        state.hooks[index] =
          typeof initial === 'function' ? initial() : initial;
      return [
        state.hooks[index],
        value => {
          state.hooks[index] = value;
        },
      ];
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
mock.module('mobx-react-lite', {
  namedExports: {observer: component => component},
});
mock.module('lucide-react', {
  namedExports: {CircleAlert: 'circle-alert'},
});
mock.module('styled-components', {
  namedExports: {
    styled: Object.assign(() => () => 'notice-button', {
      div: () => 'fingerprint-row',
    }),
    css: () => '',
  },
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => state.entrances},
});
mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {signSSHData: async () => 'signature'},
});
mock.module('../.bld/app/@components/@monoid/monoid-scan-prompt.js', {
  namedExports: {
    useMonoidScanPrompt: () => {
      state.scanPrompts++;
      return [null, async () => {}];
    },
    MonoidScanStatePromptProgress: 'progress',
  },
});
mock.module('../.bld/app/@components/@key/key-checkbox.js', {
  namedExports: {KeyCheckbox: 'checkbox'},
});
mock.module('../.bld/app/@components/@key/key-list.js', {
  namedExports: {
    KeyList: 'key-list',
    KeyListAddress: 'key-address',
    KeyListItem: 'key-item',
    KeyListItemContent: 'key-content',
    KeyListPlaceholder: 'key-placeholder',
  },
});
mock.module('../.bld/app/@components/@key/key-tags.js', {
  namedExports: {
    KeyAliasTag: 'alias',
    KeyParameterTag: 'tag',
    KeyTags: 'tags',
    KeyTypeTag: 'type',
  },
});
mock.module('../.bld/app/@components/@ui/button.js', {
  namedExports: {AsyncButton: 'button'},
});
mock.module('../.bld/app/@components/@ui/app-icon.js', {
  namedExports: {AppIcon: 'icon'},
});
mock.module('../.bld/app/@components/@ui/icon-button.js', {
  namedExports: {IconButton: 'icon-button'},
});
mock.module('../.bld/app/@components/@ui/details-popup.js', {
  namedExports: {
    DetailsPopup: 'details-popup',
    DetailsPopupTitle: 'details-title',
    DetailsPopupDivider: 'divider',
  },
});
mock.module('../.bld/app/@components/@ui/typed-data-fields.js', {
  namedExports: {TypedDataFields: 'data-fields'},
});
mock.module('../.bld/app/@components/@ui/copy-button.js', {
  namedExports: {CopyButton: 'copy'},
});
mock.module('../.bld/app/@components/@ui/info-section.js', {
  namedExports: {
    InfoSection: 'section',
    InfoSectionItem: 'item',
    InfoSectionItemContent: 'item-content',
    InfoSectionItemLabel: 'label',
    InfoSectionRow: 'row',
  },
});
mock.module('../.bld/app/@components/@ui/message-content.js', {
  namedExports: {
    MessageSectionHeader: 'data-header',
    MessageSectionTitle: 'data-title',
    WarningMessage: 'warning',
  },
});
mock.module('../.bld/app/@components/@view/index.js', {
  namedExports: {
    View: 'view',
    ViewContent: 'content',
    ViewHeader: 'header',
    ViewHeaderTitle: 'title',
    ViewPlaceholder: 'placeholder',
  },
});
mock.module('../.bld/app/@components/views/@scan/wallet-connect-site.js', {
  namedExports: {WalletConnectSite: 'site'},
});

const {SSHAccountList} = await import(
  '../.bld/app/@components/@key/ssh-account-list.js'
);
const {WalletConnectSSHRequest} = await import(
  '../.bld/app/@components/views/@sessions/wallet-connect-ssh-request.js'
);
const account =
  'monoid:ssh:ed25519.d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const missing =
  'monoid:ssh:p256.036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296';

function fixture() {
  state = {
    hooks: [],
    cursor: 0,
    back: 0,
    scanPrompts: 0,
    keys: [{account, alias: 'SSH key', type: 'ed25519', index: '010203'}],
    entrances: {
      sshKeyStore: {candidates: () => state.keys},
      walletStorageService: {keys: []},
      walletKitService: {ssh: {pending: new Map()}, sessions: new Map()},
      router: {$back: () => state.back++},
    },
  };
  return state;
}

function render(component, props) {
  state.cursor = 0;
  return component(props);
}

function all(node, type) {
  if (Array.isArray(node)) return node.flatMap(child => all(child, type));
  if (!node || typeof node !== 'object') return [];
  return [
    ...(node.type === type ? [node] : []),
    ...all(node.props?.children, type),
  ];
}

function request() {
  const f = fixture();
  const value = {
    request: {
      id: 1,
      topic: 'topic',
      verifyContext: {verified: {validation: 'UNKNOWN'}},
    },
    params: {
      account,
      algorithm: 'ssh-ed25519',
      data: 'aGVsbG8=',
      expiresAt: Math.floor(Date.now() / 1000) + 90,
    },
  };
  f.entrances.walletKitService.ssh.pending.set(
    JSON.stringify(['topic', 1]),
    value,
  );
  f.entrances.walletKitService.sessions.set('topic', {
    peer: {metadata: {name: 'Desktop'}},
  });
  const props = {
    view: {id: 1, $leaving: false, $match: {$exact: {$active: true}}},
  };
  return {f, value, props};
}

test('an authorized key missing locally remains selectable so its permission can be removed', () => {
  fixture();
  const toggled = [];
  const tree = render(SSHAccountList, {
    selected: new Set([missing]),
    onToggle: value => toggled.push(value),
  });
  const choices = all(tree, 'checkbox');
  assert.equal(choices.length, 2);
  assert.equal(choices[1].props.checked, true);
  choices[1].props.onChange();
  assert.deepEqual(toggled, [missing]);
  assert.equal(all(tree, 'key-placeholder')[0].props.children, 'Not in Safe');
});

test('SSH authorization lists select saved keys without starting card interaction', () => {
  const f = fixture();
  delete f.entrances.walletKitService;
  const selected = render(SSHAccountList, {
    selected: new Set([account]),
    onToggle: () => {},
    disabled: true,
  });
  assert.equal(all(selected, 'checkbox')[0].props.disabled, true);
  assert.equal(all(selected, 'button').length, 0);
  const empty = render(SSHAccountList, {
    accounts: [],
    selectionLabel: 'Choose SSH keys',
    onToggle: () => {},
  });
  assert.equal(all(empty, 'key-placeholder')[0].props.children, 'No SSH keys.');
  assert.equal(all(empty, 'label').length, 0);
  assert.equal(all(empty, 'button').length, 0);
  render(SSHAccountList, {accounts: [account]});
  assert.equal(f.scanPrompts, 0);
});

test('readonly SSH keys copy the complete fingerprint while selection rows contain no nested copy action', () => {
  fixture();
  const copy = all(render(SSHAccountList, {accounts: [account]}), 'copy')[0];
  assert.equal(copy.props.value, parseSSHAccount(account).fingerprint);
  assert.equal(copy.props.label, 'Copy fingerprint');
  assert.equal(
    all(render(SSHAccountList, {onToggle: () => {}}), 'copy').length,
    0,
  );
});

test('SSH derivations retain the Seed identity and expose their complete generic derivation', () => {
  const f = fixture();
  f.keys[0] = {
    ...f.keys[0],
    type: 'seed',
    derivation: {type: 'monoid-001', curve: 'ed25519', context: 'personal key'},
  };
  const tree = render(SSHAccountList, {accounts: [account]});
  assert.equal(all(tree, 'type')[0].props.children, 'seed');
  assert.equal(all(tree, 'type')[0].props.className, 'seed');
  const tag = all(tree, 'tag')[0];
  assert.equal(tag.props.children, 'ed25519 personal key');
  assert.equal(tag.props.title, 'ed25519: personal key');
  assert.match(tag.props['aria-label'], /ed25519 derivation/);
});

test('a missing local key cannot start SSH signing but keeps the request and Reject available', () => {
  const {f, props} = request();
  f.keys = [];
  const tree = render(WalletConnectSSHRequest, props);
  const content = all(tree, 'content')[0];
  const buttons = all(content.props.footer, 'button');
  assert.equal(
    buttons.find(button => button.props.children === 'Sign').props.disabled,
    true,
  );
  assert.equal(
    buttons.find(button => button.props.children === 'Reject').props.disabled,
    false,
  );
  assert.equal(all(tree, SSHAccountList)[0].props.accounts[0], account);
  assert.equal(all(tree, 'placeholder').length, 0);
});

test('SSH review follows the shared read-to-end signing rule while Reject remains visible', () => {
  const {props} = request();
  let tree = render(WalletConnectSSHRequest, props);
  const content = all(tree, 'content')[0];
  const buttons = all(content.props.footer, 'button');
  assert.equal(content.props.footerReveal, 'end');
  assert.equal(
    buttons.find(button => button.props.children === 'Reject').props
      .footerReveal,
    'always',
  );
  assert.equal(
    buttons.find(button => button.props.children === 'Sign').props.color,
    'warning',
  );
  const notice = all(tree, 'notice-button')[0];
  assert.equal(notice.props.$warning, true);
  assert.equal(notice.props['aria-haspopup'], 'dialog');
  assert.equal(all(tree, 'details-popup').length, 0);
  notice.props.onClick();
  tree = render(WalletConnectSSHRequest, props);
  assert.match(all(tree, 'warning')[0].props.children, /not a recognized SSH/);
  all(tree, 'details-popup')[0].props.onDismiss();
  assert.equal(
    all(render(WalletConnectSSHRequest, props), 'details-popup').length,
    0,
  );
});

test('Reject disables both SSH actions until the rejection response settles', async () => {
  const {f, props} = request();
  const response = Promise.withResolvers();
  f.entrances.walletKitService.ssh.reject = () => response.promise;
  let tree = render(WalletConnectSSHRequest, props);
  let buttons = all(all(tree, 'content')[0].props.footer, 'button');
  const rejecting = buttons
    .find(button => button.props.children === 'Reject')
    .props.handler();
  tree = render(WalletConnectSSHRequest, props);
  buttons = all(all(tree, 'content')[0].props.footer, 'button');
  assert.ok(buttons.every(button => button.props.disabled));
  response.resolve();
  await rejecting;
  assert.equal(f.back, 1);
});

test('recognized SSH signing data uses the shared data block and neutral explanation popup', () => {
  const string = value => {
    const data = Buffer.from(value);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    return Buffer.concat([size, data]);
  };
  const cases = [
    {
      data: Buffer.concat([
        Buffer.from('SSHSIG'),
        string('file'),
        string(''),
        string('sha512'),
        string(Buffer.alloc(64)),
      ]),
      field: ['Namespace', 'file'],
      notice: /file hash/,
    },
    {
      data: Buffer.concat([
        string(Buffer.alloc(32)),
        Buffer.from([50]),
        string('alice'),
        string('ssh-connection'),
        string('publickey'),
        Buffer.from([1]),
        string('ssh-ed25519'),
        string(parseSSHAccount(account).keyBlob),
      ]),
      field: ['Username', 'alice'],
      notice: /phone cannot verify the destination hostname/,
    },
  ];
  for (const {data, field, notice} of cases) {
    const {f, value, props} = request();
    value.params.data = data.toString('base64');
    let tree = render(WalletConnectSSHRequest, props);
    const fields = all(tree, 'data-fields')[0];
    assert.equal(fields.props.label, 'SSH signing data');
    assert.equal(
      fields.props.fields.find(item => item.name === field[0]).value,
      field[1],
    );
    assert.match(
      fields.props.fields.find(item => item.name === 'Data digest').value,
      /^SHA256:/,
    );
    assert.equal(all(tree, 'warning').length, 0);
    assert.equal(all(tree, 'details-popup').length, 0);
    assert.equal(all(tree, 'notice-button')[0].props.$warning, false);
    const buttons = all(all(tree, 'content')[0].props.footer, 'button');
    assert.equal(
      buttons.find(button => button.props.children === 'Sign').props.color,
      'primary',
    );
    all(tree, 'notice-button')[0].props.onClick();
    tree = render(WalletConnectSSHRequest, props);
    assert.equal(all(tree, 'warning').length, 0);
    assert.match(
      all(all(tree, 'details-popup')[0], 'p')[0].props.children,
      notice,
    );
    f.entrances.walletKitService.ssh.pending.clear();
    tree = render(WalletConnectSSHRequest, props);
    assert.equal(all(tree, 'details-popup').length, 0);
    assert.equal(
      all(tree, 'placeholder')[0].props.children,
      'Request no longer available',
    );
  }
});
