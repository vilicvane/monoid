import {hexlify} from 'ethers';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import {parseWalletConnectPersonalSign} from '../../@lib/wallet-connect-request.js';
import type {Router} from '../../@routes.js';
import {getWalletSigningAccount} from '../@monoid/get-wallet-signing-account.js';
import {AsyncButton, Button} from '../@ui/button.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  ViewPlaceholder,
} from '../@view/index.js';

import {WalletConnectMessage} from './@scan/wallet-connect-message.js';
import {WalletConnectSite} from './@scan/wallet-connect-site.js';
import {WalletConnectSignButton} from './@sessions/wallet-connect-sign-button.js';

export const WalletConnectRequestView = observer(
  ({view}: RouteComponentProps<Router['sessions']['request']>): ReactNode => {
    const {router, walletKitService, walletStorageService, errorService} =
      useEntrances();

    // Keep the reviewed message and site stable through replies and transitions.
    const [request] = useState(() => {
      const pending = walletKitService.requests.get(view.id);
      return pending && structuredClone(pending);
    });
    const [session] = useState(() =>
      request ? walletKitService.sessions.get(request.topic) : undefined,
    );
    const [review] = useState(() => {
      if (!request || !session) return undefined;
      try {
        return {payload: parseWalletConnectPersonalSign(request, session)};
      } catch (error) {
        return {error: (error as Error).message};
      }
    });
    const [state, setState] = useState<'signing' | 'responding'>();
    const [ended, setEnded] = useState(!request || !session);
    const active = !view.$leaving && view.$match.$exact.$active;
    const pending = walletKitService.requests.has(view.id);
    const expiry =
      Math.min(
        request?.params.request.expiryTimestamp ?? Infinity,
        session?.expiry ?? Infinity,
      ) * 1000;
    const available = !ended;
    const busy = state !== undefined;
    const payload = review?.payload;
    const account =
      payload &&
      getWalletSigningAccount(walletStorageService.keys, payload.address);
    const nextId = Array.from(walletKitService.requests.values()).find(
      request =>
        request.id !== view.id &&
        !walletKitService.isRespondingToRequest(request.id),
    )?.id;

    const complete = async (): Promise<void> => {
      if (view.$leaving || !view.$match.$exact.$active) return;

      const next = Array.from(walletKitService.requests.values()).find(
        request =>
          request.id !== view.id &&
          !walletKitService.isRespondingToRequest(request.id),
      );
      if (next) {
        await router.sessions.request({id: next.id}).$replace().$completed;
      } else if (router.$ableToBack) {
        await router.$back().$completed;
      } else {
        await router.sessions.$replace().$completed;
      }
    };

    useEffect(() => {
      if (!active || !Number.isFinite(expiry)) return;

      const timer = setTimeout(
        () => {
          setEnded(true);
          errorService.catch(walletKitService.rejectRequest(view.id));
        },
        Math.max(0, expiry - Date.now()),
      );
      return () => clearTimeout(timer);
    }, [active, expiry, errorService, walletKitService, view.id]);

    useEffect(() => {
      if (active && !pending && state !== 'responding') setEnded(true);
    }, [active, pending, state]);

    useEffect(() => {
      if (view.$leaving) {
        errorService.catch(walletKitService.rejectRequest(view.id));
      }
    }, [view.$leaving, view.id, walletKitService, errorService]);

    useEffect(
      () => () => {
        const entries = router.sessions.request.$view({
          parallel: true,
        }).$entries;
        if (!entries.some(entry => entry.id === view.id)) {
          errorService.catch(walletKitService.rejectRequest(view.id));
        }
      },
      [router, view.id, walletKitService, errorService],
    );

    useEffect(() => {
      if (active && !available && !busy && nextId !== undefined) {
        router.sessions.request({id: nextId}).$replace();
      }
    }, [active, available, busy, router, nextId]);

    const reject = async (): Promise<void> => {
      setState('responding');
      try {
        await walletKitService.rejectRequest(view.id);
        await complete();
      } finally {
        setState(undefined);
      }
    };

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Sign message</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent
          footerReveal="end"
          sectionGap={16}
          footer={
            <>
              {available &&
                payload &&
                (active ? (
                  <WalletConnectSignButton
                    view={view}
                    payload={payload}
                    disabled={busy || !account}
                    onStateChange={setState}
                    onComplete={complete}
                  />
                ) : (
                  <Button disabled loading={busy}>
                    Sign
                  </Button>
                ))}
              {available ? (
                <AsyncButton
                  footerReveal="always"
                  color="neutral"
                  disabled={busy}
                  handler={reject}
                >
                  Reject
                </AsyncButton>
              ) : (
                <Button footerReveal="always" onClick={() => void complete()}>
                  Close
                </Button>
              )}
            </>
          }
        >
          {session && request && (
            <WalletConnectSite
              metadata={session.peer.metadata}
              verified={request.verifyContext.verified}
            />
          )}
          {!available ? (
            <ViewPlaceholder role="status">
              Request no longer available
            </ViewPlaceholder>
          ) : payload ? (
            <WalletConnectMessage
              address={payload.address}
              chainId={payload.chainId}
              message={payload.text ?? hexlify(payload.message)}
              label={payload.text === undefined ? 'Message (hex)' : 'Message'}
            />
          ) : (
            <ViewPlaceholder role="status">{review?.error}</ViewPlaceholder>
          )}
        </ViewContent>
      </View>
    );
  },
);
