import {observer} from 'mobx-react-lite';
import {type ReactNode, useMemo, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import {buildWalletConnectAuthentication} from '../../@lib/wallet-connect-authentication.js';
import type {Router} from '../../@routes.js';
import {WalletAccountList} from '../@key/wallet-account-list.js';
import {AsyncButton, Button} from '../@ui/button.js';
import {InfoSectionItemLabel} from '../@ui/info-section.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  ViewPlaceholder,
} from '../@view/index.js';

import {useWalletConnectProposal} from './@scan/use-wallet-connect-proposal.js';
import {WalletConnectSite} from './@scan/wallet-connect-site.js';

export const WalletConnectView = observer(
  ({view}: RouteComponentProps<Router['scan']['connection']>): ReactNode => {
    const {router, walletKitService, walletStorageService} = useEntrances();
    const [connecting, setConnecting] = useState(false);
    const active = !view.$leaving && view.$match.$exact.$active;
    const {proposal, available} = useWalletConnectProposal(
      view.id,
      active,
      connecting,
    );
    const signIn = !!proposal?.params.requests?.authentication?.length;
    const {addresses} = view;
    const selectedAddresses = useMemo(() => new Set(addresses), [addresses]);
    const authentication = useMemo(() => {
      try {
        return {
          messages:
            available && proposal && addresses.length
              ? buildWalletConnectAuthentication(proposal, addresses)
              : [],
        };
      } catch (error) {
        return {messages: [], error: (error as Error).message};
      }
    }, [proposal, available, addresses]);

    const disabled =
      !available ||
      !active ||
      connecting ||
      !addresses.length ||
      !!authentication.error;

    const connect = async (): Promise<void> => {
      setConnecting(true);

      try {
        const session = await walletKitService.approve(view.id, addresses);
        if (session && !view.$leaving && view.$match.$exact.$active) {
          router.sessions.$reset();
        }
      } finally {
        setConnecting(false);
      }
    };

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Connect</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent
          footer={
            <>
              {signIn ? (
                <Button
                  disabled={disabled}
                  onClick={() =>
                    router.scan.connection
                      .authentication({
                        addresses: [...addresses],
                        authentication: authentication.messages,
                      })
                      .$push()
                  }
                >
                  Sign in
                </Button>
              ) : (
                <AsyncButton disabled={disabled} handler={connect}>
                  Connect
                </AsyncButton>
              )}
              <AsyncButton
                color={available ? 'neutral' : 'primary'}
                disabled={connecting}
                handler={async () => {
                  if (available) await walletKitService.reject(view.id);
                  router.scan.$reset();
                }}
              >
                {available ? 'Reject' : 'Scan again'}
              </AsyncButton>
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
            <>
              <InfoSectionItemLabel>Choose accounts</InfoSectionItemLabel>
              <WalletAccountList
                keys={walletStorageService.keys}
                addressType="evm"
                selectedAddresses={selectedAddresses}
                disabled={connecting}
                onToggle={address => {
                  const next = new Set(selectedAddresses);
                  if (next.has(address)) next.delete(address);
                  else next.add(address);
                  view.addresses = Array.from(next);
                }}
              />
              {authentication.error && (
                <InfoSectionItemLabel role="alert">
                  {authentication.error}
                </InfoSectionItemLabel>
              )}
            </>
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
