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

      // The leaving request still matches during the transition to its result.
      if (
        [
          router.features,
          router.bitcoin,
          router.sessions,
          router.ethereum,
          router.solana,
          router.scan,
          router.safe,
        ].some(route => route.$transition || route.$switching)
      ) {
        return;
      }

      // Requests received while reviewing one stay in the manual queue on exit.
      if (
        router.sessions.request.$matched ||
        router.bitcoin.wallet.send.$matched ||
        router.ethereum.wallet.transaction.replace.$matched
      ) {
        requests.forEach(({id}) => presented.add(id));
        return;
      }

      // A submitted transaction may still be waiting to notify the website.
      for (const route of [
        router.sessions.transaction,
        router.sessions.solanaTransaction,
      ]) {
        for (const view of route.$view({parallel: true}).$entries) {
          presented.add(view.id);
        }
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
        keyboard.shown
      ) {
        return;
      }

      requests.forEach(({id}) => presented.add(id));
      void router.sessions.request({id: first.id}).$push();
    });
  }, [router, walletKitService, monoidScanPromptPresenter, keyboard]);

  return null;
}
