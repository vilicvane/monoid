import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import type {Router} from '../../@routes.js';
import {Button} from '../@ui/button.js';
import {InfoSection, InfoSectionItemLabel} from '../@ui/info-section.js';
import {MessageContent} from '../@ui/message-content.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  ViewPlaceholder,
} from '../@view/index.js';

import {useWalletConnectProposal} from './@scan/use-wallet-connect-proposal.js';
import {WalletConnectApproveButton} from './@scan/wallet-connect-approve-button.js';
import {WalletConnectSite} from './@scan/wallet-connect-site.js';

export const WalletConnectAuthenticationView = observer(
  ({
    view,
  }: RouteComponentProps<
    Router['scan']['connection']['authentication']
  >): ReactNode => {
    const {router} = useEntrances();
    const [connectionState, setConnectionState] = useState<
      'signing' | 'connecting'
    >();
    const active = !view.$leaving && view.$match.$exact.$active;
    const {proposal, available} = useWalletConnectProposal(
      view.id,
      active,
      connectionState === 'connecting',
    );
    const connecting = connectionState !== undefined;

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Sign in</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent
          footerReveal="end"
          sectionGap={16}
          footer={
            <>
              {available && active && proposal ? (
                <WalletConnectApproveButton
                  view={view}
                  proposal={proposal}
                  disabled={connecting || !view.authentication.length}
                  onStateChange={setConnectionState}
                />
              ) : (
                <Button disabled loading={connecting}>
                  Sign
                </Button>
              )}
              <Button
                footerReveal="always"
                color={available ? 'neutral' : 'primary'}
                disabled={connecting}
                onClick={() => router.scan.$reset()}
              >
                {available ? 'Reject' : 'Scan again'}
              </Button>
            </>
          }
        >
          {proposal && (
            <WalletConnectSite
              metadata={proposal.params.proposer.metadata}
              verified={proposal.verifyContext.verified}
            />
          )}
          {available ? (
            view.authentication.map(({message, iss}, index) => (
              <InfoSection key={`${iss}:${index}`}>
                <InfoSectionItemLabel>
                  Message
                  {view.authentication.length > 1 &&
                    ` ${index + 1} / ${view.authentication.length}`}
                </InfoSectionItemLabel>
                <MessageContent>{message}</MessageContent>
              </InfoSection>
            ))
          ) : (
            <ViewPlaceholder role="status">
              Request no longer available
            </ViewPlaceholder>
          )}
        </ViewContent>
      </View>
    );
  },
);
