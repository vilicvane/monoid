import {SSHProtocolError, SSH_ERROR_CODES} from '@monoid/ssh-protocol';
import {CircleAlert as circleAlert} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../@entrances.js';
import {signSSHData} from '../../../@lib/monoid/index.js';
import {reviewSSHData} from '../../../@lib/ssh-request.js';
import type {Router} from '../../../@routes.js';
import {SSHAccountList} from '../../@key/ssh-account-list.js';
import {
  MonoidScanStatePromptProgress,
  useMonoidScanPrompt,
} from '../../@monoid/monoid-scan-prompt.js';
import {AppIcon} from '../../@ui/app-icon.js';
import {AsyncButton} from '../../@ui/button.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from '../../@ui/details-popup.js';
import {IconButton} from '../../@ui/icon-button.js';
import {InfoSection} from '../../@ui/info-section.js';
import {inlineIconCSS} from '../../@ui/inline-icon.js';
import {
  MessageSectionHeader,
  MessageSectionTitle,
  WarningMessage,
} from '../../@ui/message-content.js';
import {TypedDataFields} from '../../@ui/typed-data-fields.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  ViewPlaceholder,
} from '../../@view/index.js';
import {WalletConnectSite} from '../@scan/wallet-connect-site.js';

const NoticeButton = styled(IconButton)<{$warning: boolean}>`
  ${inlineIconCSS}
  color: ${({$warning}) =>
    $warning ? 'var(--color-text-warning)' : 'var(--ion-color-medium-tint)'};
`;

export const WalletConnectSSHRequest: (
  props: RouteComponentProps<Router['sessions']['request']>,
) => ReactNode = observer(function WalletConnectSSHRequest({
  view,
}: RouteComponentProps<Router['sessions']['request']>): ReactNode {
  const {walletKitService, sshKeyStore, walletStorageService, router} =
    useEntrances();
  const service = walletKitService.ssh;
  const [value] = useState(() =>
    [...service.pending.values()].find(value => value.request.id === view.id),
  );
  const [session] = useState(
    () => value && walletKitService.sessions.get(value.request.topic),
  );
  const [busy, setBusy] = useState(false);
  const [showNotice, setShowNotice] = useState(false);
  const mounted = useRef(true);
  const [scanContent, scan] = useMonoidScanPrompt({
    auth: 'access',
    retryOnError: false,
  });
  const active = !view.$leaving && view.$match.$exact.$active;
  const available =
    !!value &&
    service.pending.get(
      JSON.stringify([value.request.topic, value.request.id]),
    ) === value;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const complete = (): void => {
    if (mounted.current && !view.$leaving && view.$match.$exact.$active)
      router.$back();
  };
  const key =
    value &&
    sshKeyStore
      .candidates(walletStorageService.keys)
      .find(key => key.account === value.params.account);
  const review = value && reviewSSHData(value.params);
  return (
    <>
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>{review?.title ?? 'SSH request'}</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent
          footerReveal="end"
          footer={
            available && (
              <>
                <AsyncButton
                  data-footer-action="sign"
                  color={review?.kind === 'unknown' ? 'warning' : 'primary'}
                  disabled={busy || !active || !key}
                  handler={async () => {
                    setBusy(true);
                    try {
                      await service.sign(value, async assert => {
                        const selected = sshKeyStore
                          .candidates(walletStorageService.keys)
                          .find(key => key.account === value.params.account);
                        if (!selected)
                          throw new SSHProtocolError(
                            SSH_ERROR_CODES.keyUnavailable,
                          );
                        let signature: string | undefined;
                        await scan(
                          'Scan card to sign',
                          async (applet, setContent, _hello, signal) => {
                            const check = (): void => {
                              signal.throwIfAborted();
                              assert();
                              if (
                                !mounted.current ||
                                view.$leaving ||
                                !view.$match.$exact.$active
                              )
                                throw new SSHProtocolError(
                                  SSH_ERROR_CODES.cancelled,
                                );
                            };
                            check();
                            setContent(
                              <MonoidScanStatePromptProgress
                                current={0}
                                total={1}
                              >
                                Signing
                              </MonoidScanStatePromptProgress>,
                            );
                            signature = await signSSHData(
                              applet,
                              selected,
                              value.params,
                              check,
                            );
                            check();
                            setContent(
                              <MonoidScanStatePromptProgress
                                current={1}
                                total={1}
                              >
                                Signing
                              </MonoidScanStatePromptProgress>,
                            );
                          },
                        );
                        assert();
                        if (!signature)
                          throw new SSHProtocolError(SSH_ERROR_CODES.cancelled);
                        return signature;
                      });
                      complete();
                    } finally {
                      if (mounted.current) setBusy(false);
                    }
                  }}
                >
                  Sign
                </AsyncButton>
                <AsyncButton
                  footerReveal="always"
                  color="neutral"
                  disabled={busy || !active}
                  handler={async () => {
                    setBusy(true);
                    try {
                      await service.reject(value);
                      complete();
                    } finally {
                      if (mounted.current) setBusy(false);
                    }
                  }}
                >
                  Reject
                </AsyncButton>
              </>
            )
          }
        >
          {session && value && (
            <WalletConnectSite
              metadata={session.peer.metadata}
              verified={value.request.verifyContext.verified}
              compact
            />
          )}
          {available && value && review ? (
            <>
              <InfoSection>
                <SSHAccountList accounts={[value.params.account]} compact />
              </InfoSection>
              <InfoSection>
                <MessageSectionHeader>
                  <MessageSectionTitle>Data</MessageSectionTitle>
                  <NoticeButton
                    feedback="color"
                    $warning={review.kind === 'unknown'}
                    aria-label="About SSH signing data"
                    aria-haspopup="dialog"
                    onClick={() => setShowNotice(true)}
                  >
                    <AppIcon icon={circleAlert} aria-hidden="true" />
                  </NoticeButton>
                </MessageSectionHeader>
                <TypedDataFields
                  label="SSH signing data"
                  fields={review.fields.map(([name, data]) => ({
                    kind: 'value',
                    name,
                    type: 'string',
                    value: data,
                  }))}
                />
              </InfoSection>
            </>
          ) : (
            <ViewPlaceholder role="status">
              Request no longer available
            </ViewPlaceholder>
          )}
        </ViewContent>
      </View>
      {active && available && review && showNotice && (
        <DetailsPopup
          aria-label="About SSH signing data"
          initialFocus="dialog"
          onDismiss={() => setShowNotice(false)}
        >
          <DetailsPopupTitle>{review.title}</DetailsPopupTitle>
          <DetailsPopupDivider />
          {review.kind === 'unknown' ? (
            <WarningMessage>{review.notice}</WarningMessage>
          ) : (
            <p>{review.notice}</p>
          )}
        </DetailsPopup>
      )}
      {scanContent}
    </>
  );
});
