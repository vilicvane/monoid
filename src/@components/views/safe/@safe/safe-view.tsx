import {IonFabButton, IonIcon} from '@ionic/react';
import {card} from 'ionicons/icons';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../../@entrances.js';
import type {Router} from '../../../../@routes.js';
import {
  View,
  ViewContent,
  ViewFab,
  ViewHeader,
  ViewHeaderTitle,
} from '../../../@view/index.js';

import {KeyItem} from './@key-item.js';

const List = styled.div`
  flex: 1;
  margin: 0 calc(-1 * var(--view-padding));
`;

export const SafeView = observer(
  ({view, transition}: RouteComponentProps<Router['safe']>): ReactNode => {
    const {router, walletStorageService} = useEntrances();

    return (
      <View>
        <ViewHeader>
          <ViewHeaderTitle>Safe</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent>
          <List>
            {walletStorageService.keys.map(key => (
              <KeyItem key={key.index} data={key} />
            ))}
          </List>
        </ViewContent>
        <ViewFab view={view} transition={transition}>
          <IonFabButton onClick={() => router.safe.scanCard.$push()}>
            <IonIcon icon={card} />
          </IonFabButton>
        </ViewFab>
      </View>
    );
  },
);
