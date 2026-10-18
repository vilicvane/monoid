import {observer} from 'mobx-react-lite';
import {type ReactNode, useMemo, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import {normalizeWalletAddress} from '../../@lib/wallet-address.js';
import {buildWalletConnectAuthentication} from '../../@lib/wallet-connect-authentication.js';
import {
  buildWalletConnectNamespaces,
  getWalletConnectProposalAddressTypes,
} from '../../@lib/wallet-connect.js';
import type {Router} from '../../@routes.js';
import {WalletAccountList} from '../@key/wallet-account-list.js';
import {AsyncButton, Button} from '../@ui/button.js';
import {ErrorMessage} from '../@ui/message-content.js';
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
    const addressTypes = proposal
      ? getWalletConnectProposalAddressTypes(proposal)
      : [];
    const selectedAddresses = useMemo(
      () => new Set(addresses.map(normalizeWalletAddress)),
      [addresses],
    );
    const authentication = useMemo(() => {
      try {
        if (available && proposal && addresses.length) {
          buildWalletConnectNamespaces(proposal, addresses);
          return {
            messages: buildWalletConnectAuthentication(proposal, addresses),
          };
        }

        return {
          messages: [],
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
            available && (
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
            <>
              <WalletAccountList
                selectionLabel="Choose accounts"
                keys={walletStorageService.keys}
                addressType={addressTypes}
                selectedAddresses={selectedAddresses}
                disabled={connecting}
                onToggle={address => {
                  const identity = normalizeWalletAddress(address);
                  view.addresses = selectedAddresses.has(identity)
                    ? addresses.filter(
                        item => normalizeWalletAddress(item) !== identity,
                      )
                    : [...addresses, address];
                }}
              />
              {authentication.error && (
                <ErrorMessage role="alert">{authentication.error}</ErrorMessage>
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
