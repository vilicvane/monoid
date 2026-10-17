import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import {getPendingActions} from '../../@lib/pending-action.js';
import type {Router} from '../../@routes.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  ViewPlaceholder,
} from '../@view/index.js';

import {SessionList, SessionListItem} from './@sessions/session-list-item.js';

export const SessionsView = observer(
  ({view}: RouteComponentProps<Router['sessions']>): ReactNode => {
    const {router, walletKitService} = useEntrances();
    const actions = getPendingActions(walletKitService);
    const pendingTopics = new Set(actions.map(action => action.request.topic));
    const active = !view.$leaving && view.$match.$exact.$active;

    return (
      <View inert={!active}>
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
                  hasPendingRequest={pendingTopics.has(topic)}
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
  },
);
