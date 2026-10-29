import {IonFabButton} from '@ionic/react';
import {
  ArrowRightLeft as arrowRightLeft,
  Ellipsis as ellipsis,
} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import {getPendingActions} from '../../@lib/pending-action.js';
import {getSSHSessionAccounts} from '../../@lib/ssh-request.js';
import type {Router} from '../../@routes.js';
import {
  getWalletKitSessionAddressTypes,
  getWalletKitSessionAddresses,
} from '../../@services/index.js';
import {SSHAccountList} from '../@key/ssh-account-list.js';
import {WalletAccountList} from '../@key/wallet-account-list.js';
import {AppIcon} from '../@ui/app-icon.js';
import {AsyncButton} from '../@ui/button.js';
import {CenteredPopup} from '../@ui/centered-popup.js';
import {PopupDateTime} from '../@ui/date-time.js';
import {
  InfoSection,
  InfoSectionItemLabel,
  InfoSectionRow,
} from '../@ui/info-section.js';
import {InfoMessage} from '../@ui/message-content.js';
import {
  View,
  ViewContent,
  ViewFab,
  ViewHeader,
  ViewHeaderButton,
  ViewHeaderTitle,
} from '../@view/index.js';

import {WalletConnectSite} from './@scan/wallet-connect-site.js';
import {PendingRequests} from './@sessions/pending-requests.js';
import {useSession} from './@sessions/use-session.js';

export const SessionView = observer(
  ({
    view,
    transition,
  }: RouteComponentProps<Router['sessions']['session']>): ReactNode => {
    const {router, walletKitService, walletStorageService} = useEntrances();
    const [pending, setPending] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const active = !view.$leaving && view.$match.$exact.$active;
    const data = useSession(view.topic, active);
    if (!data) return null;

    const {session, record} = data;
    const addresses = getWalletKitSessionAddresses(session);
    const sshAccounts = getSSHSessionAccounts(session);
    const addressTypes = getWalletKitSessionAddressTypes(session);
    const canSwitch = walletKitService.canSwitchAccount(view.topic);
    const actions = getPendingActions(walletKitService).filter(
      action => action.request.topic === view.topic,
    );
    const nextRequest = actions[0]?.request;

    const disconnect = async (): Promise<void> => {
      setPending(true);

      try {
        await walletKitService.disconnect(session.topic);
        setMenuOpen(false);
      } finally {
        setPending(false);
      }
    };

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Session</ViewHeaderTitle>
          <ViewHeaderButton
            aria-label="Session actions"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            disabled={!walletKitService.sessions.has(view.topic) || pending}
            onClick={() => setMenuOpen(true)}
          >
            <AppIcon icon={ellipsis} />
          </ViewHeaderButton>
        </ViewHeader>
        <ViewContent>
          <WalletConnectSite
            metadata={session.peer.metadata}
            verified={record.verified}
          />
          <InfoSection>
            <InfoSectionRow>
              <InfoSectionItemLabel>Connected</InfoSectionItemLabel>
              <PopupDateTime value={record.connectedAt} />
            </InfoSectionRow>
            <InfoSectionRow>
              <InfoSectionItemLabel>Last active</InfoSectionItemLabel>
              <PopupDateTime value={record.lastActivityAt} />
            </InfoSectionRow>
          </InfoSection>
          {addressTypes.length > 0 && (
            <InfoSection>
              <WalletAccountList
                keys={walletStorageService.keys}
                addressType={addressTypes}
                addresses={addresses.filter(
                  address => !address.startsWith('monoid:ssh:'),
                )}
              />
            </InfoSection>
          )}
          {sshAccounts.length > 0 && (
            <InfoSection>
              <SSHAccountList
                accounts={
                  walletKitService.ssh.getDesiredAccounts(session.topic) ??
                  sshAccounts
                }
              />
            </InfoSection>
          )}
          {walletKitService.ssh.syncing.has(session.topic) && (
            <InfoMessage>
              Account changes are not synchronized. Retry Switch or disconnect.
              Removed keys remain unauthorized.
            </InfoMessage>
          )}
          {!canSwitch && (
            <InfoSection>
              <InfoSectionItemLabel>
                This site does not support account switching.
              </InfoSectionItemLabel>
            </InfoSection>
          )}
          <PendingRequests
            actions={actions}
            onSelect={action =>
              router.sessions.request({id: action.request.id}).$push()
            }
          />
        </ViewContent>
        {!nextRequest && (
          <ViewFab view={view} transition={transition} inert={!active}>
            <IonFabButton
              aria-label="Switch Account"
              disabled={pending || !canSwitch}
              onClick={() => view.$match.switchAccounts.$push()}
            >
              <AppIcon icon={arrowRightLeft} />
            </IonFabButton>
          </ViewFab>
        )}
        {menuOpen && active && walletKitService.sessions.has(view.topic) && (
          <CenteredPopup
            aria-label="Session actions"
            onDismiss={() => setMenuOpen(false)}
          >
            <AsyncButton color="danger" disabled={pending} handler={disconnect}>
              Disconnect
            </AsyncButton>
          </CenteredPopup>
        )}
      </View>
    );
  },
);
