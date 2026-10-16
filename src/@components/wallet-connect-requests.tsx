import {autorun} from 'mobx';
import {useEffect} from 'react';

import {useEntrances} from '../@entrances.js';

export function WalletConnectRequests(): null {
  const {router, walletKitService, monoidScanPromptPresenter, keyboard} =
    useEntrances();

  useEffect(
    () =>
      autorun(() => {
        const first = Array.from(walletKitService.requests.values()).find(
          request => !walletKitService.isRespondingToRequest(request.id),
        );
        if (
          !first ||
          !router.$path ||
          router.sessions.request.$matched ||
          router.scan.connection.$matched ||
          monoidScanPromptPresenter.current ||
          keyboard.shown ||
          [router.sessions, router.scan, router.safe].some(
            route => route.$transition || route.$switching,
          )
        ) {
          return;
        }

        void router.sessions.request({id: first.id}).$push();
      }),
    [router, walletKitService, monoidScanPromptPresenter, keyboard],
  );

  return null;
}
