import type {ReactNode} from 'react';
import type {MatchComponentProps} from 'routra-react';
import {Route} from 'routra-react';

import type {Router} from '../../../@routes.js';

import {CardView} from './@card-view.js';
import {SafeView} from './@safe-view.js';
import {ScanCardView} from './@scan-card-view.js';

export const SafeMatch = ({
  route,
}: MatchComponentProps<Router['safe']>): ReactNode => {
  return (
    <>
      <Route view={route.$exact.$view()} component={SafeView} />
      <Route view={route.scanCard.$view()} component={ScanCardView} />
      <Route view={route.card.$view()} component={CardView} />
    </>
  );
};
