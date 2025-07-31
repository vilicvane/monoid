import {IonFabButton, IonIcon} from '@ionic/react';
import {linkOutline} from 'ionicons/icons';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';

import type {Router} from '../../@routes.js';

import {ViewFab} from './@view-fab.js';

export const SafeDerivableKeyViewFab = ({
  view,
  transition,
}: RouteComponentProps<Router['safe']['derivableKey']>): ReactNode => {
  return (
    <ViewFab view={view} transition={transition}>
      <IonFabButton onClick={() => view.$match.derive.$push()}>
        <IonIcon icon={linkOutline} />
      </IonFabButton>
    </ViewFab>
  );
};
