import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import {useEntrances} from '../../@entrances.js';
import {getWalletConnectRequestExpiry} from '../../@lib/wallet-connect-authentication.js';
import {Button} from '../@ui/button.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  ViewPlaceholder,
} from '../@view/index.js';

import {SessionList, SessionListItem} from './@sessions/session-list-item.js';

export const SessionsView = observer((): ReactNode => {
  const {router, walletKitService} = useEntrances();
  const nextRequest = Array.from(walletKitService.requests.values()).find(
    request => !walletKitService.isRespondingToRequest(request.id),
  );
  const nextProposal = Array.from(walletKitService.proposals.values()).find(
    proposal => getWalletConnectRequestExpiry(proposal) > Date.now(),
  );

  return (
    <View>
      <ViewHeader>
        <ViewHeaderTitle>Sessions</ViewHeaderTitle>
      </ViewHeader>
      <ViewContent
        footer={
          (nextRequest || nextProposal) && (
            <Button
              onClick={() => {
                if (nextRequest) {
                  router.sessions.request({id: nextRequest.id}).$push();
                } else {
                  router.scan.connection({id: nextProposal!.id}).$push();
                }
              }}
            >
              View next request
            </Button>
          )
        }
      >
        {walletKitService.sessions.size ? (
          <SessionList>
            {Array.from(walletKitService.sessions, ([topic, session]) => (
              <SessionListItem
                key={topic}
                session={session}
                record={walletKitService.sessionRecords.get(topic)!}
                onClick={() => router.sessions.session({topic}).$push()}
              />
            ))}
          </SessionList>
        ) : (
          <ViewPlaceholder>No connected sites</ViewPlaceholder>
        )}
      </ViewContent>
    </View>
  );
});
