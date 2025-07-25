import {up} from 'entrance-decorator';
import {createRoot} from 'react-dom/client';
import * as x from 'x-value';

import {Entrances, EntrancesContext} from './@entrances.js';
import {XUint8Array, xCBOR} from './@x-value/index.js';
import App from './app.js';

function hexToBytes(hex: string): number[] {
  return hex.match(/.{2}/g)?.map(byte => parseInt(byte, 16)) ?? [];
}

up(new Entrances())
  .then(entrances => {
    createRoot(document.getElementById('root')!).render(
      <EntrancesContext.Provider value={entrances}>
        <App />
      </EntrancesContext.Provider>,
    );
  })
  .catch(console.error);
