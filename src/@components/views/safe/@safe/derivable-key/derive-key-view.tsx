import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';

import type {Router} from '../../../../../@routes.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../../../../@view/index.js';

export const DeriveKeyView = ({}: RouteComponentProps<
  Router['safe']['derivableKey']['derive']
>): ReactNode => {
  return (
    <View>
      <ViewHeader>
        <ViewHeaderTitle>Derive Key</ViewHeaderTitle>
      </ViewHeader>
      <ViewContent>
        <p>
          This view allows you to derive a new key from the existing key
          information. Please follow the instructions provided.
        </p>
      </ViewContent>
    </View>
  );
};
