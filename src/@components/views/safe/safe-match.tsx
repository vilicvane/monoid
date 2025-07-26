import type {ReactNode} from 'react';
import type {MatchComponentProps} from 'routra-react';
import {Route} from 'routra-react';

import type {Router} from '../../../@routes.js';

import {SafeImportView} from './@safe-import-view.js';
import {SafeView} from './@safe-view.js';

export const SafeMatch = ({
  route,
}: MatchComponentProps<Router['safe']>): ReactNode => {
  return (
    <>
      <Route view={route.$exact.$view()} component={SafeView} />
      <Route view={route.import.$view()} component={SafeImportView} />
    </>
  );
};
