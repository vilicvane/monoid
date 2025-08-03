import type {ToastOptions} from '@ionic/react';
import {useIonToast} from '@ionic/react';
import type {HookOverlayOptions} from '@ionic/react/dist/types/hooks/HookOverlayOptions.js';
import {useCallback} from 'react';

const DURATION_DEFAULT = 3000;

export function useToast(): (
  options: ToastOptions & HookOverlayOptions,
) => void {
  const [present] = useIonToast();

  return useCallback(
    options =>
      void present({
        duration: DURATION_DEFAULT,
        positionAnchor: 'nav-bar',
        swipeGesture: 'vertical',
        ...options,
      }),
    [present],
  );
}
