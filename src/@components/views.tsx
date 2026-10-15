import type {ReactNode} from 'react';
import {Match, Route} from 'routra-react';

import {useEntrances} from '../@entrances.js';

import {SafeMatch} from './views/safe/index.js';
import {ScanView} from './views/scan-view.js';
import {SessionSwitchView} from './views/session-switch-view.js';
import {SessionView} from './views/session-view.js';
import {SessionsView} from './views/sessions-view.js';
import {WalletConnectView} from './views/wallet-connect-view.js';

export const Views = (): ReactNode => {
  const {router} = useEntrances();

  return (
    <>
      <Route view={router.sessions.$exact.$view()} component={SessionsView} />
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
        view={router.scan.connection.$view({parallel: true})}
        component={WalletConnectView}
      />
      <Match match={router.safe} component={SafeMatch} />
    </>
  );
};
