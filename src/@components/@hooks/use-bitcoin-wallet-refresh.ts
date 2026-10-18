import {useEffect} from 'react';

import {useEntrances} from '../../@entrances.js';

export function useBitcoinWalletRefresh(
  address: string,
  active: boolean,
): void {
  const {bitcoinWalletService} = useEntrances();

  useEffect(() => {
    if (!active) return;

    const refresh = (): void => {
      const state = bitcoinWalletService.get(address);
      if (
        document.visibilityState === 'visible' &&
        state.status !== 'loading' &&
        !state.loadingMore
      ) {
        void bitcoinWalletService.refresh(address, {preserveHistory: true});
      }
    };

    refresh();
    const timer = setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', refresh);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [active, address, bitcoinWalletService]);
}
