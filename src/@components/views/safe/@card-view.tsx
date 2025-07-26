import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';

import type {Router} from '../../../@routes.js';
import {View} from '../../@view.js';

export const CardView = ({
  view,
}: RouteComponentProps<Router['safe']['card']>): ReactNode => {
  return (
    <View>
      <h1>Card View</h1>
      <p>Card ID: {view.card.id}</p>
      <ul>
        {view.card.keys.map((key, index) => (
          <li key={index}>
            Type: {key.type}
            <br />
            Index: {key.index}
          </li>
        ))}
      </ul>
    </View>
  );
};
