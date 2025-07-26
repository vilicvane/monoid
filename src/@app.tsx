import {IonApp, setupIonicReact} from '@ionic/react';
import type {ReactNode} from 'react';
import {useEffect} from 'react';

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
import '@ionic/react/css/palettes/dark.class.css';

import './@styles/variables.css';
import './@styles/overrides.css';

import {NavBar, Views} from './@components/index.js';
import {useEntrances} from './@entrances.js';

setupIonicReact();

const App = (): ReactNode => {
  const {router} = useEntrances();

  useEffect(() => {
    const listener = (event: any): void => {
      event.detail.register(0, () => {
        if (router.$ableToBack) {
          router.$back();
        }
      });
    };

    document.addEventListener('ionBackButton', listener);

    return () => {
      document.removeEventListener('ionBackButton', listener);
    };
  }, [router]);

  return (
    <IonApp>
      <Views />
      <NavBar />
    </IonApp>
  );
};

export default App;
