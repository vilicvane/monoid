import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

let state;

mock.module('mobx-react-lite', {namedExports: {observer: value => value}});
mock.module('react/jsx-runtime', {
  namedExports: {
    jsx: (type, props) => ({type, props}),
    jsxs: (type, props) => ({type, props}),
    Fragment: 'fragment',
  },
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => state.entrances},
});
mock.module('../.bld/app/@lib/bitcoin-wallet.js', {
  namedExports: {getBitcoinWalletSigningAccount: () => state.account},
});
mock.module('../.bld/app/@components/@hooks/use-bitcoin-wallet-refresh.js', {
  namedExports: {
    useBitcoinWalletRefresh: (...args) => state.refreshes.push(args),
  },
});
mock.module('../.bld/app/@components/@view/index.js', {
  namedExports: {
    useViewActive: () => () => state.active,
    View: 'view',
    ViewContent: 'content',
    ViewHeader: 'header',
    ViewHeaderTitle: 'title',
    ViewLoading: 'loading',
    ViewPlaceholder: 'placeholder',
  },
});
mock.module('../.bld/app/@components/@key/wallet-account-list.js', {
  namedExports: {WalletAccountList: 'account'},
});
mock.module('../.bld/app/@components/@ui/info-section.js', {
  namedExports: {InfoSection: 'section', InfoSectionItemLabel: 'label'},
});
mock.module('../.bld/app/@components/@ui/button.js', {
  namedExports: {Button: 'button'},
});
mock.module('../.bld/app/@components/@ui/date-time.js', {
  namedExports: {PopupDateTime: 'date'},
});
mock.module('../.bld/app/@components/@ui/message-content.js', {
  namedExports: {ErrorMessage: 'error', WarningMessage: 'warning'},
});
mock.module('../.bld/app/@components/views/@sessions/transaction-list.js', {
  namedExports: {TransactionList: 'list'},
});
mock.module(
  '../.bld/app/@components/views/@sessions/ethereum-transaction-list.js',
  {
    namedExports: {EthereumTransactionListItem: 'ethereum-row'},
  },
);
mock.module(
  '../.bld/app/@components/views/@sessions/solana-transaction-list.js',
  {
    namedExports: {SolanaTransactionListItem: 'solana-row'},
  },
);
mock.module(
  '../.bld/app/@components/views/@sessions/bitcoin-transaction-list.js',
  {
    namedExports: {
      BitcoinTransactionListItem: 'bitcoin-row',
      BitcoinSubmissionListItem: 'submission-row',
    },
  },
);

const {EthereumTransactionsView} = await import(
  '../.bld/app/@components/views/ethereum-transactions-view.js'
);
const {SolanaTransactionsView} = await import(
  '../.bld/app/@components/views/solana-transactions-view.js'
);
const {BitcoinTransactionsView} = await import(
  '../.bld/app/@components/views/bitcoin-transactions-view.js'
);

function mount() {
  state = {
    active: true,
    account: {wallet: {addressType: 'bitcoin-taproot'}},
    bitcoin: {status: 'idle', loadingMore: false},
    submissions: [],
    refreshes: [],
    loads: [],
    reads: [],
    pushed: [],
    ethereum: [],
    solana: [],
  };
  const route = chain => ({
    wallet: account => ({
      transaction: transaction => ({
        $push: () => state.pushed.push({chain, account, transaction}),
      }),
    }),
  });
  state.entrances = {
    router: {
      ethereum: route('ethereum'),
      solana: route('solana'),
      bitcoin: route('bitcoin'),
    },
    walletStorageService: {keys: []},
    transactionHistoryService: {
      list: address => {
        state.reads.push(['ethereum', address]);
        return state.ethereum;
      },
    },
    solanaTransactionHistoryService: {
      list: address => {
        state.reads.push(['solana', address]);
        return state.solana;
      },
    },
    bitcoinWalletService: {
      get: () => state.bitcoin,
      getSubmissions: () => state.submissions,
      loadMore: address => state.loads.push(address),
    },
  };
  return state;
}

function nodes(element) {
  if (Array.isArray(element)) return element.flatMap(nodes);
  if (!element || typeof element !== 'object') return [];
  if (typeof element.type === 'function')
    return nodes(element.type(element.props));
  return [element, ...nodes(element.props.children)];
}

function render(component, address = 'wallet-address') {
  return nodes(component({view: {address}}));
}

for (const [chain, component, transaction, expected] of [
  [
    'ethereum',
    EthereumTransactionsView,
    {chainId: 1, hash: 'evm-hash'},
    {chainId: 'eip155:1', hash: 'evm-hash'},
  ],
  [
    'solana',
    SolanaTransactionsView,
    {chainId: 'solana:mainnet', id: 'solana-id'},
    {chainId: 'solana:mainnet', id: 'solana-id'},
  ],
]) {
  test(`${chain} history reads its own service and opens its own transaction route`, () => {
    mount();
    state[chain] = [transaction];
    const tree = render(component);
    assert.deepEqual(state.reads, [[chain, 'wallet-address']]);
    const row = tree.find(node => node.type === `${chain}-row`);
    assert.equal(row.props.active, true);
    row.props.onClick();
    assert.deepEqual(state.pushed, [
      {chain, account: {address: 'wallet-address'}, transaction: expected},
    ]);
    state.active = false;
    row.props.onClick();
    assert.equal(state.pushed.length, 1);
    const inactive = render(component);
    assert.equal(inactive.find(node => node.type === 'view').props.inert, true);
    assert.equal(
      inactive.find(node => node.type === `${chain}-row`).props.active,
      false,
    );
  });
}

test('Bitcoin history preserves cached rows, pending submissions, errors and pagination', () => {
  mount();
  state.bitcoin = {
    status: 'error',
    loadingMore: false,
    error: 'Refresh failed',
    historyError: 'Older history failed',
    snapshot: {
      transactions: [{txid: 'known'}],
      updatedAt: 1234,
      pendingHistoryTruncated: true,
      hasMore: true,
    },
  };
  state.submissions = [
    {txid: 'known', status: 'submitted'},
    {txid: 'confirmed', status: 'confirmed'},
    {txid: 'retryable', status: 'unknown'},
  ];
  const tree = render(BitcoinTransactionsView);
  assert.deepEqual(state.refreshes, [['wallet-address', true]]);
  assert.equal(tree.filter(node => node.type === 'error').length, 2);
  assert.equal(tree.filter(node => node.type === 'warning').length, 1);
  assert.equal(tree.find(node => node.type === 'date').props.value, 1234);
  const rows = tree.filter(node =>
    ['submission-row', 'bitcoin-row'].includes(node.type),
  );
  assert.deepEqual(
    rows.map(row => row.props.transaction?.txid ?? row.props.submission.txid),
    ['retryable', 'known'],
  );
  rows[0].props.onClick();
  assert.deepEqual(state.pushed[0], {
    chain: 'bitcoin',
    account: {address: 'wallet-address'},
    transaction: {txid: 'retryable'},
  });
  const more = tree.find(node => node.type === 'button');
  more.props.onClick();
  assert.deepEqual(state.loads, ['wallet-address']);
  state.active = false;
  more.props.onClick();
  rows[1].props.onClick();
  assert.equal(state.loads.length, 1);
  assert.equal(state.pushed.length, 1);
});

test('Bitcoin history retains distinct loading, failed, empty and unavailable states', () => {
  mount();
  assert.equal(
    render(BitcoinTransactionsView).some(node => node.type === 'loading'),
    true,
  );
  state.bitcoin = {status: 'error', loadingMore: false, error: 'Offline'};
  const failed = render(BitcoinTransactionsView);
  assert.equal(
    failed.some(node => node.type === 'loading' || node.type === 'placeholder'),
    false,
  );
  assert.equal(
    failed.find(node => node.type === 'error').props.children[0],
    'Offline',
  );
  state.bitcoin = {status: 'ready', snapshot: {transactions: []}};
  assert.equal(
    render(BitcoinTransactionsView).find(node => node.type === 'placeholder')
      .props.children,
    'No transactions',
  );
  state.account = undefined;
  const unavailable = render(BitcoinTransactionsView);
  assert.equal(
    unavailable.find(node => node.type === 'placeholder').props.children,
    'This Bitcoin wallet is no longer in Safe.',
  );
  assert.equal(
    unavailable.some(node => node.type === 'account'),
    false,
  );
  assert.deepEqual(state.refreshes.at(-1), ['wallet-address', false]);
});
