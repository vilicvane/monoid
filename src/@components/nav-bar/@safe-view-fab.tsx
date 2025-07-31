import {IonFabButton, IonIcon} from '@ionic/react';
import {card} from 'ionicons/icons';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import type {Router} from '../../@routes.js';

import {ViewFab} from './@view-fab.js';

export const SafeViewFab = ({
  view,
  transition,
}: RouteComponentProps<Router['safe']>): ReactNode => {
  const {router} = useEntrances();

  return (
    <ViewFab view={view} transition={transition}>
      <IonFabButton onClick={() => router.safe.scanCard.$push()}>
        <IonIcon icon={card} />
      </IonFabButton>
    </ViewFab>
  );
};
