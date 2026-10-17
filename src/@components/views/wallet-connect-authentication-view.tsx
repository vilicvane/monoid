import {getNamespacedDidChainId} from '@walletconnect/utils';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import type {Router} from '../../@routes.js';
import {AsyncButton, Button} from '../@ui/button.js';
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
import {WalletConnectMessage} from './@scan/wallet-connect-message.js';
import {WalletConnectSite} from './@scan/wallet-connect-site.js';

export const WalletConnectAuthenticationView = observer(
  ({
    view,
  }: RouteComponentProps<
    Router['scan']['connection']['authentication']
  >): ReactNode => {
    const {router, walletKitService} = useEntrances();
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
          footer={
            available && (
              <>
                {active && proposal ? (
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
                <AsyncButton
                  footerReveal="always"
                  color="neutral"
                  disabled={connecting}
                  handler={async () => {
                    await walletKitService.reject(view.id);
                    router.scan.$reset();
                  }}
                >
                  Reject
                </AsyncButton>
              </>
            )
          }
        >
          {proposal && (
            <WalletConnectSite
              metadata={proposal.params.proposer.metadata}
              verified={proposal.verifyContext.verified}
            />
          )}
          {available ? (
            view.authentication.map(({address, message, iss}, index) => (
              <WalletConnectMessage
                key={`${iss}:${index}`}
                address={address}
                chainId={getNamespacedDidChainId(iss)!}
              >
                <MessageContent
                  aria-label={
                    view.authentication.length > 1
                      ? `Message ${index + 1} / ${view.authentication.length}`
                      : 'Message'
                  }
                >
                  {message}
                </MessageContent>
              </WalletConnectMessage>
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
