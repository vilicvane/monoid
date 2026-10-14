import {Clipboard} from '@capacitor/clipboard';
import {useIonToast} from '@ionic/react';
import copy from 'lucide-static/icons/copy.svg';
import ms from 'ms';

const COPIED_TOAST_DURATION = ms('2s');

export const useCopyAddress = (): ((address: string) => Promise<void>) => {
  const [toast] = useIonToast();

  return async address => {
    await Clipboard.write({string: address});

    await toast({
      icon: copy,
      message: 'Address copied to clipboard',
      duration: COPIED_TOAST_DURATION,
      positionAnchor: 'nav-bar',
    });
  };
};
