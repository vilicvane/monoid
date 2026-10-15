import {useEffect, useState} from 'react';

import {useEntrances} from '../../../@entrances.js';
import type {
  WalletKitSession,
  WalletKitSessionRecord,
} from '../../../@services/index.js';

type SessionData = {
  session: WalletKitSession;
  record: WalletKitSessionRecord;
};

export function useSession(
  topic: string,
  active: boolean,
): SessionData | undefined {
  const {router, walletKitService} = useEntrances();
  const session = walletKitService.sessions.get(topic);
  const record = walletKitService.sessionRecords.get(topic)!;
  const [lastSession, setLastSession] = useState(
    () => session && {session, record},
  );

  useEffect(() => {
    if (session) {
      setLastSession({session, record});
    } else if (active) {
      router.sessions.$reset();
    }
  }, [session, record, active, router.sessions]);

  // Retain the site's content while an expired or disconnected page fades out.
  return session ? {session, record} : lastSession;
}
