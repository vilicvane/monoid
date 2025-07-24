import {
  IonApp,
  IonContent,
  IonHeader,
  IonIcon,
  IonLabel,
  IonRouterOutlet,
  IonTab,
  IonTabBar,
  IonTabButton,
  IonTabs,
  IonTitle,
  IonToolbar,
  setupIonicReact,
} from '@ionic/react';
import {IonReactRouter} from '@ionic/react-router';
import {
  ellipse,
  fileTrayFullOutline,
  globe,
  globeOutline,
  globeSharp,
  keyOutline,
  library,
  lockClosedOutline,
  playCircle,
  radio,
  scan,
  search,
  square,
  triangle,
} from 'ionicons/icons';
import {useEffect, useState} from 'react';

/* Core CSS required for Ionic components to work properly */
import '@ionic/react/css/core.css';

/* Basic CSS for apps built with Ionic */
import '@ionic/react/css/normalize.css';
import '@ionic/react/css/structure.css';
import '@ionic/react/css/typography.css';

/* Optional CSS utils that can be commented out */
import '@ionic/react/css/padding.css';
import '@ionic/react/css/float-elements.css';
import '@ionic/react/css/text-alignment.css';
import '@ionic/react/css/text-transformation.css';
import '@ionic/react/css/flex-utils.css';
import '@ionic/react/css/display.css';

/**
 * Ionic Dark Mode
 * -----------------------------------------------------
 * For more info, please see:
 * https://ionicframework.com/docs/theming/dark-mode
 */

/* import '@ionic/react/css/palettes/dark.always.css'; */
/* import '@ionic/react/css/palettes/dark.class.css'; */
import '@ionic/react/css/palettes/dark.system.css';

/* Theme variables */
import './theme/variables.css';

import {JavaCardApplet} from './lib/javacard.js';

import {Nfc} from '@capawesome-team/capacitor-nfc';

setupIonicReact();

const App: React.FC = () => {
  // const [applet] = useState(
  //   () =>
  //     new JavaCardApplet(
  //       new Uint8Array([
  //         0xf0, 0x6d, 0x6f, 0x6e, 0x6f, 0x69, 0x64, 0x01, 0x01, 0x00, 0x00,
  //       ]),
  //     ),
  // );

  // useEffect(() => {
  //   Nfc.addListener('nfcTagScanned', async event => {
  //     console.log('NFC Tag Scanned:', event);
  //     // Handle NFC tag scanned event

  //     for (let index = 0; index < 1000; index++) {
  //       await applet.sendCommand(0x30, {
  //         auth: {
  //           pin: '123456',
  //         },
  //       });

  //       await applet.sendCommand(0x2f, {
  //         auth: {
  //           pin: '123456',
  //         },
  //       });
  //     }
  //   });

  //   return () => {
  //     Nfc.removeAllListeners();
  //   };
  // }, [applet]);

  return (
    <IonApp>
      <IonTabs>
        <IonTab tab="sessions">
          <div id="sessions-page">
            <IonHeader>
              <IonToolbar>
                <IonTitle>Sessions</IonTitle>
              </IonToolbar>
            </IonHeader>
            <IonContent>
              <div className="example-content">Sessions content</div>
            </IonContent>
          </div>
        </IonTab>
        <IonTab tab="connect">
          <div id="connect-page">
            <IonHeader>
              <IonToolbar>
                <IonTitle>Connect</IonTitle>
              </IonToolbar>
            </IonHeader>
            <IonContent>
              <div className="example-content">Connect content</div>
            </IonContent>
          </div>
        </IonTab>
        <IonTab tab="safe">
          <div id="safe-page">
            <IonHeader>
              <IonToolbar>
                <IonTitle>Safe</IonTitle>
              </IonToolbar>
            </IonHeader>
            <IonContent>
              <div className="example-content">Safe content</div>
            </IonContent>
          </div>
        </IonTab>

        <IonTabBar slot="bottom">
          <IonTabButton tab="sessions">
            <IonIcon icon={globeOutline} />
          </IonTabButton>
          <IonTabButton tab="connect">
            <IonIcon icon={scan} />
          </IonTabButton>
          <IonTabButton tab="safe">
            <IonIcon icon={lockClosedOutline} />
          </IonTabButton>
        </IonTabBar>
      </IonTabs>
    </IonApp>
  );
};

export default App;
