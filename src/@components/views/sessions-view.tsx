import {Unplug as unplug} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import {getPendingActions} from '../../@lib/pending-action.js';
import type {Router} from '../../@routes.js';
import {AppIcon} from '../@ui/app-icon.js';
import {IconList} from '../@ui/list.js';
import {
  SwipeAction,
  SwipeActionIcon,
  SwipeableItem,
} from '../@ui/swipeable-item.js';
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
    const {router, walletKitService, errorService} = useEntrances();
    const [openTopic, setOpenTopic] = useState<string>();
    const [disconnecting, setDisconnecting] = useState<ReadonlySet<string>>(
      new Set(),
    );
    const actions = getPendingActions(walletKitService);
    const pendingTopics = new Set(actions.map(action => action.request.topic));
    const active = !view.$leaving && view.$match.$exact.$active;
    const sessions = Array.from(walletKitService.sessions.values()).sort(
      (a, b) =>
        walletKitService.sessionRecords.get(b.topic)!.lastActivityAt -
        walletKitService.sessionRecords.get(a.topic)!.lastActivityAt,
    );

    const disconnect = async (topic: string): Promise<void> => {
      setOpenTopic(undefined);
      setDisconnecting(current => new Set(current).add(topic));
      try {
        await walletKitService.disconnect(topic);
      } finally {
        setDisconnecting(current => {
          const next = new Set(current);
          next.delete(topic);
          return next;
        });
      }
    };

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Sessions</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent>
          {walletKitService.sessions.size ? (
            <IconList>
              {sessions.map(session => (
                <SwipeableItem
                  key={session.topic}
                  open={openTopic === session.topic}
                  disabled={disconnecting.has(session.topic)}
                  onOpenChange={open =>
                    setOpenTopic(open ? session.topic : undefined)
                  }
                  actions={
                    <SwipeAction
                      type="button"
                      $color="var(--ion-color-danger)"
                      disabled={disconnecting.has(session.topic)}
                      onClick={errorService.catch(() =>
                        disconnect(session.topic),
                      )}
                    >
                      <SwipeActionIcon>
                        <AppIcon icon={unplug} />
                      </SwipeActionIcon>
                      Disconnect
                    </SwipeAction>
                  }
                >
                  <SessionListItem
                    session={session}
                    record={walletKitService.sessionRecords.get(session.topic)!}
                    hasPendingRequest={pendingTopics.has(session.topic)}
                    onClick={() =>
                      openTopic
                        ? setOpenTopic(undefined)
                        : router.sessions
                            .session({topic: session.topic})
                            .$push()
                    }
                  />
                </SwipeableItem>
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
