import type {ReactNode} from 'react';
import {Match, Route} from 'routra-react';

import {useEntrances} from '../@entrances.js';

import {SafeMatch} from './views/safe/index.js';
import {SessionsView} from './views/sessions-view.js';

export const Views = (): ReactNode => {
  const {router} = useEntrances();

  return (
    <>
      <Route view={router.sessions.$view()} component={SessionsView} />
      <Match match={router.safe} component={SafeMatch} />
    </>
  );
};
