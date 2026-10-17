import type {ReactNode} from 'react';
import {Match, Route} from 'routra-react';

import {useEntrances} from '../@entrances.js';

import {SafeMatch} from './views/safe/index.js';
import {ScanView} from './views/scan-view.js';
import {SessionSwitchView} from './views/session-switch-view.js';
import {SessionView} from './views/session-view.js';
import {SessionsView} from './views/sessions-view.js';
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
      <Route view={router.sessions.$exact.$view()} component={SessionsView} />
      <Route
        view={router.sessions.request.$view({parallel: true})}
        component={WalletConnectRequestView}
      />
      <Route
        view={router.sessions.transaction.$view({parallel: true})}
        component={TransactionView}
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
