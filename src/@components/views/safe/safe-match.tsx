import type {ReactNode} from 'react';
import type {MatchComponentProps} from 'routra-react';
import {Route} from 'routra-react';

import type {Router} from '../../../@routes.js';

import {CardView} from './@card/index.js';
import {
  DerivableKeyView,
  DeriveKeyView,
  RawKeyView,
  SafeView,
} from './@safe/index.js';
import {ScanCardView} from './@scan-card-view.js';

export const SafeMatch = ({
  route,
}: MatchComponentProps<Router['safe']>): ReactNode => {
  return (
    <>
      <Route view={route.$exact.$view()} component={SafeView} />
      <Route
        view={route.derivableKey.$exact.$view()}
        component={DerivableKeyView}
      />
      <Route
        view={route.derivableKey.derive.$view()}
        component={DeriveKeyView}
      />
      <Route view={route.rawKey.$exact.$view()} component={RawKeyView} />
      <Route view={route.scanCard.$view()} component={ScanCardView} />
      <Route view={route.card.$view()} component={CardView} />
    </>
  );
};
