import {
  IonButton,
  IonContent,
  IonHeader,
  IonIcon,
  IonPage,
  IonTitle,
  IonToolbar,
} from '@ionic/react';

import ExploreContainer from '../components/ExploreContainer.js';

import './Tab3.css';
import {ellipsisHorizontal} from 'ionicons/icons';

const Tab3: React.FC = () => {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Tab 3</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <IonHeader collapse="condense">
          <IonToolbar>
            <IonTitle size="large">Tab 3</IonTitle>
            <IonButton>
              <IonIcon icon={ellipsisHorizontal} />
            </IonButton>
          </IonToolbar>
        </IonHeader>
        <ExploreContainer name="Tab 3 page" />
      </IonContent>
    </IonPage>
  );
};

export default Tab3;
