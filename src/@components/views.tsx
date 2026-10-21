import type {ReactNode} from 'react';
import {Match, Route} from 'routra-react';

import {useEntrances} from '../@entrances.js';

import {BitcoinSendView} from './views/bitcoin-send-view.js';
import {BitcoinTransactionView} from './views/bitcoin-transaction-view.js';
import {BitcoinTransactionsView} from './views/bitcoin-transactions-view.js';
import {BitcoinWalletView} from './views/bitcoin-wallet-view.js';
import {BitcoinWalletsView} from './views/bitcoin-wallets-view.js';
import {CardManagementView} from './views/card/card-management-view.js';
import {EthereumTransactionHistoryView} from './views/ethereum-transaction-history-view.js';
import {EthereumTransactionReplacementView} from './views/ethereum-transaction-replacement-view.js';
import {EthereumTransactionsView} from './views/ethereum-transactions-view.js';
import {EthereumWalletsView} from './views/ethereum-wallets-view.js';
import {FeaturesView} from './views/features-view.js';
import {SafeMatch} from './views/safe/index.js';
import {ScanView} from './views/scan-view.js';
import {SessionSwitchView} from './views/session-switch-view.js';
import {SessionView} from './views/session-view.js';
import {SessionsRequestFab} from './views/sessions-request-fab.js';
import {SessionsView} from './views/sessions-view.js';
import {SolanaTransactionHistoryView} from './views/solana-transaction-history-view.js';
import {SolanaTransactionView} from './views/solana-transaction-view.js';
import {SolanaTransactionsView} from './views/solana-transactions-view.js';
import {SolanaWalletsView} from './views/solana-wallets-view.js';
import {TransactionView} from './views/transaction-view.js';
import {WalletConnectAuthenticationView} from './views/wallet-connect-authentication-view.js';
import {WalletConnectRequestView} from './views/wallet-connect-request-view.js';
import {WalletConnectView} from './views/wallet-connect-view.js';
import {WalletConnectRequests} from './wallet-connect-requests.js';

export const Views = (): ReactNode => {
  const {router} = useEntrances();

  return (
    <>
      <WalletConnectRequests />
      <SessionsRequestFab />
      <Route view={router.features.$view()} component={FeaturesView} />
      <Route view={router.cardApplets.$view()} component={CardManagementView} />
      <Route
        view={router.bitcoin.$exact.$view()}
        component={BitcoinWalletsView}
      />
      <Route
        view={router.bitcoin.wallet.$exact.$view()}
        component={BitcoinWalletView}
      />
      <Route
        view={router.bitcoin.wallet.send.$view({parallel: true})}
        component={BitcoinSendView}
      />
      <Route
        view={router.bitcoin.wallet.transactions.$view()}
        component={BitcoinTransactionsView}
      />
      <Route
        view={router.bitcoin.wallet.transaction.$view({parallel: true})}
        component={BitcoinTransactionView}
      />
      <Route view={router.sessions.$exact.$view()} component={SessionsView} />
      <Route
        view={router.ethereum.$exact.$view()}
        component={EthereumWalletsView}
      />
      <Route
        view={router.ethereum.wallet.$exact.$view()}
        component={EthereumTransactionsView}
      />
      <Route
        view={router.ethereum.wallet.transaction.$exact.$view({
          parallel: true,
        })}
        component={EthereumTransactionHistoryView}
      />
      <Route
        view={router.ethereum.wallet.transaction.replace.$view({
          parallel: true,
        })}
        component={EthereumTransactionReplacementView}
      />
      <Route
        view={router.solana.$exact.$view()}
        component={SolanaWalletsView}
      />
      <Route
        view={router.solana.wallet.$exact.$view()}
        component={SolanaTransactionsView}
      />
      <Route
        view={router.solana.wallet.transaction.$view({
          parallel: true,
        })}
        component={SolanaTransactionHistoryView}
      />
      <Route
        view={router.sessions.request.$view({parallel: true})}
        component={WalletConnectRequestView}
      />
      <Route
        view={router.sessions.transaction.$view({parallel: true})}
        component={TransactionView}
      />
      <Route
        view={router.sessions.solanaTransaction.$view({parallel: true})}
        component={SolanaTransactionView}
      />
      <Route
        view={router.sessions.session.$exact.$view()}
        component={SessionView}
      />
      <Route
        view={router.sessions.session.switchAccounts.$view()}
        component={SessionSwitchView}
      />
      <Route view={router.scan.$exact.$view()} component={ScanView} />
      <Route
        view={router.scan.connection.$exact.$view({parallel: true})}
        component={WalletConnectView}
      />
      <Route
        view={router.scan.connection.authentication.$view({parallel: true})}
        component={WalletConnectAuthenticationView}
      />
      <Match match={router.safe} component={SafeMatch} />
    </>
  );
};
