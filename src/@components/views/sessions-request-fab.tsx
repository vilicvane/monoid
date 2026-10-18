import {IonFabButton} from '@ionic/react';
import {Pencil as pencil} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect} from 'react';
import {$view, type ViewEntry} from 'routra';
import {Route, type RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import {
  type PendingAction,
  getPendingActions,
} from '../../@lib/pending-action.js';
import {getWalletConnectRequestExpiry} from '../../@lib/wallet-connect-authentication.js';
import type {Router} from '../../@routes.js';
import {AppIcon} from '../@ui/app-icon.js';
import {ViewFab} from '../@view/index.js';

type SessionRoute = Router['sessions'] | Router['sessions']['session'];

const RequestFab = observer(
  ({view, transition}: RouteComponentProps<SessionRoute>): ReactNode => {
    const {router, walletKitService} = useEntrances();
    const topic =
      view.$match.$path.length === 2
        ? (view as ViewEntry<Router['sessions']['session']>).topic
        : undefined;
    const actions = getPendingActions(walletKitService);
    const proposal = Array.from(walletKitService.proposals.values()).find(
      item => getWalletConnectRequestExpiry(item) > Date.now(),
    );
    const getNext = (
      sessionTopic?: string,
    ): {
      request: PendingAction['request'] | undefined;
      proposal: typeof proposal;
    } => ({
      request: actions.find(
        action =>
          sessionTopic === undefined || action.request.topic === sessionTopic,
      )?.request,
      proposal: sessionTopic === undefined ? proposal : undefined,
    });
    const current = getNext(topic);
    const enteringSession = router.sessions.session.$exact
      .$view()
      .$entries.find(entry => entry.$entering);
    const destination = router.sessions.$exact.$transition
      ? getNext()
      : enteringSession
        ? getNext(enteringSession.topic)
        : undefined;
    const next =
      current.request || current.proposal ? current : (destination ?? current);
    const {request: nextRequest, proposal: nextProposal} = next;
    const visible = !!(nextRequest || nextProposal);

    useEffect(() => {
      // This route only owns a FAB, so an empty queue has no animation to wait for.
      if (!visible) view.$transition({entering: false, leaving: false});
    }, [view, visible]);

    if (!visible) return null;

    // Keep the same element when both pages offer requests. A destination
    // without requests still needs the normal exit animation.
    const leaving =
      !!view.$leaving && !destination?.request && !destination?.proposal;

    return (
      <ViewFab
        view={view}
        transition={transition}
        leaving={leaving}
        inert={!!view.$leaving || !view.$match.$exact.$active}
      >
        <IonFabButton
          aria-label="View next request"
          onClick={() => {
            if (nextRequest) {
              router.sessions.request({id: nextRequest.id}).$push();
            } else {
              router.scan.connection({id: nextProposal!.id}).$push();
            }
          }}
        >
          <AppIcon icon={pencil} />
        </IonFabButton>
      </ViewFab>
    );
  },
);

export const SessionsRequestFab = (): ReactNode => {
  const {router} = useEntrances();

  return (
    <Route
      view={$view([router.sessions.$exact, router.sessions.session.$exact])}
      component={RequestFab}
    />
  );
};
