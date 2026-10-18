import type {ReactNode} from 'react';
import {Match, Route} from 'routra-react';

import {useEntrances} from '../@entrances.js';

import {FeaturesView} from './views/features-view.js';
import {SafeMatch} from './views/safe/index.js';
import {ScanView} from './views/scan-view.js';
import {SessionSwitchView} from './views/session-switch-view.js';
import {SessionView} from './views/session-view.js';
import {SessionsRequestFab} from './views/sessions-request-fab.js';
import {SessionsView} from './views/sessions-view.js';
import {SolanaTransactionView} from './views/solana-transaction-view.js';
import {TransactionHistoryView} from './views/transaction-history-view.js';
import {TransactionReplacementView} from './views/transaction-replacement-view.js';
import {TransactionView} from './views/transaction-view.js';
import {TransactionWalletsView} from './views/transaction-wallets-view.js';
import {TransactionsView} from './views/transactions-view.js';
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
      <Route view={router.sessions.$exact.$view()} component={SessionsView} />
      <Route
        view={router.transactions.$exact.$view()}
        component={TransactionWalletsView}
      />
      <Route
        view={router.transactions.wallet.$exact.$view()}
        component={TransactionsView}
      />
      <Route
        view={router.transactions.wallet.transaction.$exact.$view({
          parallel: true,
        })}
        component={TransactionHistoryView}
      />
      <Route
        view={router.transactions.wallet.transaction.replace.$view({
          parallel: true,
        })}
        component={TransactionReplacementView}
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
