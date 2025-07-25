import {
  IonButton,
  IonButtons,
  IonContent,
  IonFab,
  IonFabButton,
  IonHeader,
  IonIcon,
  IonPage,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import {
  add,
  addCircle,
  addOutline,
  addSharp,
  ellipsisHorizontal,
  ellipsisVertical,
  enterOutline,
} from 'ionicons/icons';
import type {ReactNode} from 'react';

import ExploreContainer from '../components/ExploreContainer.js';

import {ellipsisIconProps} from './@miscellaneous.js';

export const SafeView = (): ReactNode => {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Safe x</IonTitle>
          {/* <IonButtons slot="primary">
            <IonButton>
              <IonIcon slot="icon-only" icon={addOutline} />
            </IonButton>
            <IonButton>
              <IonIcon slot="icon-only" {...ellipsisIconProps} />
            </IonButton>
          </IonButtons> */}
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <IonFab slot="fixed" vertical="top" horizontal="end" edge>
          <IonFabButton>
            <IonIcon icon={add} />
          </IonFabButton>
        </IonFab>
        <IonHeader collapse="condense">
          <IonToolbar>
            <IonTitle size="large">Tab 3</IonTitle>
            {/* <IonButtons slot="primary">
              <IonButton>
                <IonIcon slot="icon-only" {...ellipsisIconProps} />
              </IonButton>
            </IonButtons> */}
          </IonToolbar>
        </IonHeader>
      </IonContent>
    </IonPage>
  );
};
