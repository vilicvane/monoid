import type {ToastOptions} from '@ionic/react';
import {useIonToast} from '@ionic/react';
import type {HookOverlayOptions} from '@ionic/react/dist/types/hooks/HookOverlayOptions.js';
import {when} from 'mobx';
import ms from 'ms';
import {useCallback} from 'react';

import {useEntrances} from '../../@entrances.js';
import {sleep} from '../../@utils/index.js';

const DURATION_DEFAULT = 3000;

export function useToast(): (
  options: ToastOptions & HookOverlayOptions,
) => void {
  const {keyboard} = useEntrances();

  const [present] = useIonToast();

  return useCallback(
    options => {
      void (async () => {
        if (keyboard.shown) {
          await when(() => !keyboard.shown);
          await sleep(ms('200ms'));
        }

        const positionAnchor = 'position' in options ? undefined : 'nav-bar';

        await present({
          duration: DURATION_DEFAULT,
          positionAnchor,
          swipeGesture: 'vertical',
          ...options,
        });
      })();
    },
    [keyboard, present],
  );
}
