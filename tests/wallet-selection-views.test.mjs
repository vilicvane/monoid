import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

let fixture;

mock.module('react', {namedExports: {useMemo: create => create()}});
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
mock.module('styled-components', {
  namedExports: {styled: {span: () => 'pending-status'}},
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => fixture.entrances},
});
mock.module('../.bld/app/@services/index.js', {
  namedExports: {getKeyWallets: key => key.wallets},
});
mock.module('../.bld/app/@lib/bitcoin-wallet.js', {
  namedExports: {BITCOIN_ADDRESS_TYPES: ['bitcoin-segwit', 'bitcoin-taproot']},
});
mock.module('../.bld/app/@components/@hooks/use-transaction-confirmation.js', {
  namedExports: {
    useTransactionConfirmation: (...args) => fixture.ethereum.push(args),
  },
});
mock.module(
  '../.bld/app/@components/@hooks/use-solana-transaction-confirmation.js',
  {
    namedExports: {
      useSolanaTransactionConfirmation: (...args) => fixture.solana.push(args),
    },
  },
);
mock.module('../.bld/app/@components/@key/wallet-account-list.js', {
  namedExports: {WalletAccountList: 'wallet-list'},
});
mock.module('../.bld/app/@components/@ui/loading-spinner.js', {
  namedExports: {LoadingSpinner: 'spinner'},
});
const {useViewActive} = await import(
  '../.bld/app/@components/@view/use-view-active.js'
);
mock.module('../.bld/app/@components/@view/index.js', {
  namedExports: {
    View: 'view',
    ViewContent: 'content',
    ViewHeader: 'header',
    ViewHeaderTitle: 'title',
    useViewActive,
  },
});

const {EthereumWalletsView} = await import(
  '../.bld/app/@components/views/ethereum-wallets-view.js'
);
const {SolanaWalletsView} = await import(
  '../.bld/app/@components/views/solana-wallets-view.js'
);
const {BitcoinWalletsView} = await import(
  '../.bld/app/@components/views/bitcoin-wallets-view.js'
);

const EVM = '0xAa00000000000000000000000000000000000001';
const SOLANA = 'SolanaAddress';
const OTHER_SOLANA = 'SecondSolanaAddress';

function find(node, predicate) {
  if (!node) return;
  if (predicate(node)) return node;
  for (const child of Array.isArray(node) ? node : [node.props?.children]) {
    const result = find(child, predicate);
    if (result) return result;
  }
}

function mount(component, chain, pending = [], {active = true} = {}) {
  const state = {
    ethereum: [],
    solana: [],
    opened: [],
    view: {$leaving: false},
  };
  const source = {$entries: [state.view]};
  state.view.$match = {$exact: {$active: active}, $view: () => source};
  state.entrances = {
    walletStorageService: {
      keys: [
        {
          index: 'key',
          wallets: [
            {addressType: 'evm', address: EVM},
            {addressType: 'solana', address: SOLANA},
            {addressType: 'solana', address: OTHER_SOLANA},
            {addressType: 'bitcoin-segwit', address: 'bc1qexample'},
          ],
        },
      ],
    },
    router: Object.fromEntries(
      ['ethereum', 'solana', 'bitcoin'].map(name => [
        name,
        {
          wallet: options => ({
            $push: () => state.opened.push([name, options]),
          }),
        },
      ]),
    ),
  };
  for (const [name, expected] of [
    ['transactionHistoryService', 'ethereum'],
    ['solanaTransactionHistoryService', 'solana'],
  ]) {
    Object.defineProperty(state.entrances, name, {
      get() {
        assert.equal(
          chain,
          expected,
          `Do not subscribe to ${expected} from ${chain}`,
        );
        return {pendingTransactions: pending};
      },
    });
  }
  fixture = state;
  state.page = component({view: state.view});
  for (const watcher of state.page.props.children ?? [])
    watcher.type(watcher.props);
  state.tree = state.page.type(state.page.props);
  state.list = find(state.tree, node => node.type === 'wallet-list');
  state.remove = () => source.$entries.splice(0);
  return state;
}

test('Ethereum lists EVM wallets and watches only their Ethereum pending transactions', () => {
  const pending = [
    {from: EVM.toLowerCase(), chainId: '1', hash: 'first'},
    {from: EVM, chainId: '10', hash: 'second'},
    {
      from: '0xbb00000000000000000000000000000000000002',
      chainId: '1',
      hash: 'unknown',
    },
  ];
  const state = mount(EthereumWalletsView, 'ethereum', pending);

  assert.equal(
    find(state.tree, node => node.type === 'title').props.children,
    'Ethereum',
  );
  assert.equal(state.list.props.addressType, 'evm');
  assert.equal(state.list.props.selectionLabel, 'Choose wallet');
  assert.deepEqual(state.ethereum, [
    [pending[0], true],
    [pending[1], true],
  ]);
  assert.deepEqual(state.solana, []);
  assert.equal(
    state.list.props.renderStatus([EVM]).props['aria-label'],
    '2 pending transactions',
  );
  assert.equal(state.list.props.renderStatus([SOLANA]), null);
  state.list.props.onOpen(EVM);
  assert.deepEqual(state.opened, [['ethereum', {address: EVM}]]);
});

test('Solana deduplicates signature watchers while retaining each account pending count', () => {
  const pending = [
    {address: SOLANA, chainId: 'solana:mainnet', signature: 'same'},
    {address: OTHER_SOLANA, chainId: 'solana:mainnet', signature: 'same'},
    {address: SOLANA, chainId: 'solana:devnet', signature: 'same'},
    {address: SOLANA, chainId: 'solana:mainnet'},
    {
      address: SOLANA.toLowerCase(),
      chainId: 'solana:mainnet',
      signature: 'case-sensitive',
    },
  ];
  const state = mount(SolanaWalletsView, 'solana', pending);

  assert.equal(
    find(state.tree, node => node.type === 'title').props.children,
    'Solana',
  );
  assert.equal(state.list.props.addressType, 'solana');
  assert.deepEqual(state.solana, [
    ['solana:mainnet', 'same', true],
    ['solana:devnet', 'same', true],
  ]);
  assert.deepEqual(state.ethereum, []);
  assert.equal(
    state.list.props.renderStatus([SOLANA]).props['aria-label'],
    '2 pending transactions',
  );
  assert.equal(
    state.list.props.renderStatus([OTHER_SOLANA]).props['aria-label'],
    '1 pending transaction',
  );
  assert.equal(
    state.list.props.renderStatus([SOLANA, OTHER_SOLANA]).props['aria-label'],
    '3 pending transactions',
  );
  state.list.props.onOpen(SOLANA);
  assert.deepEqual(state.opened, [['solana', {address: SOLANA}]]);
});

test('Bitcoin shares wallet selection layout without subscribing to either transaction history', () => {
  const state = mount(BitcoinWalletsView, 'bitcoin');

  assert.equal(
    find(state.tree, node => node.type === 'title').props.children,
    'Bitcoin',
  );
  assert.deepEqual(state.list.props.addressType, [
    'bitcoin-segwit',
    'bitcoin-taproot',
  ]);
  assert.equal(state.list.props.renderStatus, undefined);
  assert.deepEqual(state.ethereum, []);
  assert.deepEqual(state.solana, []);
  state.list.props.onOpen('bc1qexample');
  assert.deepEqual(state.opened, [['bitcoin', {address: 'bc1qexample'}]]);
});

for (const [component, chain, pending] of [
  [
    EthereumWalletsView,
    'ethereum',
    [{from: EVM, chainId: '1', hash: 'pending'}],
  ],
  [
    SolanaWalletsView,
    'solana',
    [{address: SOLANA, chainId: 'solana:mainnet', signature: 'pending'}],
  ],
  [BitcoinWalletsView, 'bitcoin', []],
]) {
  test(`${chain} stops confirmation activity while inactive and rejects late navigation after removal`, () => {
    const state = mount(component, chain, pending, {active: false});
    assert.equal(state.tree.props.inert, true);
    assert.ok(
      [...state.ethereum, ...state.solana].every(args => args.at(-1) === false),
    );
    state.list.props.onOpen('ignored');
    assert.deepEqual(state.opened, []);
    state.view.$match.$exact.$active = true;
    state.remove();
    state.list.props.onOpen('removed');
    assert.deepEqual(state.opened, []);
  });
}
