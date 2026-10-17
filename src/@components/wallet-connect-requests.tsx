import {autorun} from 'mobx';
import {useEffect} from 'react';

import {useEntrances} from '../@entrances.js';

export function WalletConnectRequests(): null {
  const {router, walletKitService, monoidScanPromptPresenter, keyboard} =
    useEntrances();

  useEffect(() => {
    let presented = new Set<number>();

    return autorun(() => {
      const requests = Array.from(walletKitService.requests.values());
      presented = new Set(
        requests.filter(request => presented.has(request.id)).map(({id}) => id),
      );

      // Requests received while reviewing one stay in the manual queue on exit.
      if (
        router.sessions.request.$matched ||
        router.sessions.transaction.$matched
      ) {
        requests.forEach(({id}) => presented.add(id));
        return;
      }

      const first = requests.find(
        request =>
          !presented.has(request.id) &&
          !walletKitService.isRespondingToRequest(request.id),
      );
      if (
        !first ||
        !router.$path ||
        router.scan.connection.$matched ||
        monoidScanPromptPresenter.current ||
        keyboard.shown ||
        [router.sessions, router.scan, router.safe].some(
          route => route.$transition || route.$switching,
        )
      ) {
        return;
      }

      requests.forEach(({id}) => presented.add(id));
      void router.sessions.request({id: first.id}).$push();
    });
  }, [router, walletKitService, monoidScanPromptPresenter, keyboard]);

  return null;
}
