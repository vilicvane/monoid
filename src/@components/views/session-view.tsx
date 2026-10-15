import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import type {Router} from '../../@routes.js';
import {getWalletKitSessionAddresses} from '../../@services/index.js';
import {AsyncButton, Button} from '../@ui/button.js';
import {DateTime} from '../@ui/date-time.js';
import {
  InfoSection,
  InfoSectionItemLabel,
  InfoSectionRow,
} from '../@ui/info-section.js';
import {InteractiveAddress} from '../@ui/interactive-address.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../@view/index.js';

import {WalletConnectSite} from './@scan/wallet-connect-site.js';
import {useSession} from './@sessions/use-session.js';

export const SessionView = observer(
  ({view}: RouteComponentProps<Router['sessions']['session']>): ReactNode => {
    const {walletKitService} = useEntrances();
    const [pending, setPending] = useState(false);
    const active = !view.$leaving && view.$match.$exact.$active;
    const data = useSession(view.topic, active);
    if (!data) return null;

    const {session, record} = data;
    const addresses = getWalletKitSessionAddresses(session);
    const canSwitch = walletKitService.canSwitchAccount(view.topic);

    const disconnect = async (): Promise<void> => {
      setPending(true);

      try {
        await walletKitService.disconnect(session.topic);
      } finally {
        setPending(false);
      }
    };

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Session</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent
          footerPlacement="fixed"
          footer={
            <>
              <Button
                disabled={!canSwitch || pending}
                onClick={() => view.$match.switchAccounts.$push()}
              >
                Switch Account
              </Button>
              <AsyncButton
                color="danger"
                disabled={!walletKitService.sessions.has(view.topic) || pending}
                handler={disconnect}
              >
                Disconnect
              </AsyncButton>
            </>
          }
        >
          <WalletConnectSite
            metadata={session.peer.metadata}
            verified={record.verified}
          />
          <InfoSection>
            <InfoSectionRow>
              <InfoSectionItemLabel>Connected</InfoSectionItemLabel>
              <DateTime value={record.connectedAt} />
            </InfoSectionRow>
            <InfoSectionRow>
              <InfoSectionItemLabel>Last active</InfoSectionItemLabel>
              <DateTime value={record.lastActivityAt} />
            </InfoSectionRow>
          </InfoSection>
          <InfoSection>
            <InfoSectionItemLabel>Connected accounts</InfoSectionItemLabel>
            {addresses.map(address => (
              <InteractiveAddress key={address} copyable>
                {address}
              </InteractiveAddress>
            ))}
          </InfoSection>
          {!canSwitch && (
            <InfoSection>
              <InfoSectionItemLabel>
                This site does not support account switching.
              </InfoSectionItemLabel>
            </InfoSection>
          )}
        </ViewContent>
      </View>
    );
  },
);
