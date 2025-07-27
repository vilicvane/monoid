import {up} from 'entrance-decorator';
import * as MobX from 'mobx';
import {createRoot} from 'react-dom/client';

import App from './@app.js';
import {Entrances, EntrancesContext} from './@entrances.js';

MobX.configure({
  enforceActions: 'observed',
});

up(new Entrances())
  .then(entrances => {
    createRoot(document.getElementById('root')!).render(
      <EntrancesContext.Provider value={entrances}>
        <App />
      </EntrancesContext.Provider>,
    );
  })
  .catch(console.error);
