import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import {useEntrances} from '../../@entrances.js';
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

  return (
    <View>
      <ViewHeader>
        <ViewHeaderTitle>Sessions</ViewHeaderTitle>
      </ViewHeader>
      <ViewContent>
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
