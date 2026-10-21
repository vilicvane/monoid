import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import {getPendingActions} from '../../@lib/pending-action.js';
import type {Router} from '../../@routes.js';
import {IconList} from '../@ui/list.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  ViewPlaceholder,
} from '../@view/index.js';

import {SessionListItem} from './@sessions/session-list-item.js';

export const SessionsView = observer(
  ({view}: RouteComponentProps<Router['sessions']>): ReactNode => {
    const {router, walletKitService} = useEntrances();
    const actions = getPendingActions(walletKitService);
    const pendingTopics = new Set(actions.map(action => action.request.topic));
    const active = !view.$leaving && view.$match.$exact.$active;
    const sessions = Array.from(walletKitService.sessions.values()).sort(
      (a, b) =>
        walletKitService.sessionRecords.get(b.topic)!.lastActivityAt -
        walletKitService.sessionRecords.get(a.topic)!.lastActivityAt,
    );

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Sessions</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent>
          {walletKitService.sessions.size ? (
            <IconList>
              {sessions.map(session => (
                <SessionListItem
                  key={session.topic}
                  session={session}
                  record={walletKitService.sessionRecords.get(session.topic)!}
                  hasPendingRequest={pendingTopics.has(session.topic)}
                  onClick={() =>
                    router.sessions.session({topic: session.topic}).$push()
                  }
                />
              ))}
            </IconList>
          ) : (
            <ViewPlaceholder>No connected sites</ViewPlaceholder>
          )}
        </ViewContent>
      </View>
    );
  },
);
