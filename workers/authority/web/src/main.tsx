import {setupIonicReact} from '@ionic/react';
import {createRoot} from 'react-dom/client';
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {styled} from 'styled-components';
import {Lock} from 'lucide-react';
import '@ionic/react/css/core.css';
import '@ionic/react/css/normalize.css';
import '@ionic/react/css/structure.css';
import '@ionic/react/css/typography.css';
import '../../../../src/@styles/variables.css';
import {Button, Buttons} from './button.js';
import monoidLogo from '../../../../src/@assets/monoid.svg';
import {AppIcon} from '../../../../src/@components/@ui/app-icon.js';
import {
  IconTag,
  IconTagName,
} from '../../../../src/@components/@ui/icon-tag.js';
import {WhiteTag} from '../../../../src/@components/@ui/tag.js';
import {InfoSectionItemLabel} from '../../../../src/@components/@ui/info-section.js';
import {StandaloneLoadingSpinner} from '../../../../src/@components/@ui/loading-spinner.js';
import {
  InfoMessage,
  WarningMessage,
} from '../../../../src/@components/@ui/message-content.js';
import {OperationComplete} from './operation-complete.js';
import {ViewHeaderTitle} from '../../../../src/@components/@view/view-header.js';
import {AccountCard} from './account.js';
import {BrowserFlow, LoginError, restoreFlow} from './flow.mjs';
import type {Identity, ReownLogin} from './reown.js';
import './style.css';

setupIonicReact();

const Content = styled.div`
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 24px;
`;

const Actions = styled(Buttons)`
  flex: 0 0 auto;
`;

const IdentityBlock = styled.header`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  text-align: center;
`;

const Logo = styled.img`
  width: 56px;
  height: 56px;
  border-radius: 14px;
  background: var(--ion-color-primary);
`;

const Title = styled(ViewHeaderTitle)`
  font-size: 24px;
  line-height: 32px;
`;

const AuthorityTag = styled(IconTag)`
  align-self: center;
`;

const LockTag = styled(WhiteTag).attrs({as: 'span'})`
  padding: 0;
  font-size: 14px;
`;

const Secondary = styled(InfoSectionItemLabel).attrs({as: 'p'})`
  --color-text-label: var(--color-text-secondary);
  margin: 0;
  line-height: 1.5;
  text-align: center;
`;

const Preparing = styled.div`
  display: flex;
  justify-content: center;
  padding: 16px 0;
`;

const Completed = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 16px;

  > :first-child {
    flex: none;
  }
`;

const Page = styled.main`
  --view-padding: 16px;
  width: 100%;
  max-width: 400px;
  min-height: 100dvh;
  margin: 0 auto;
  padding: calc(48px + var(--view-inset-top)) 16px
    calc(16px + var(--view-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 32px;
  background: var(--ion-color-primary-contrast);

  @media (min-width: 600px) {
    padding-top: calc(16px + var(--view-inset-top));
    justify-content: center;
    gap: 0;

    ${Content} {
      flex: 0 0 auto;
    }

    ${IdentityBlock} + ${Content}:not(:empty) {
      margin-top: 32px;
    }

    ${Actions} {
      margin: var(--view-section-gap, 16px) 0 0;

      &:empty {
        display: none;
      }
    }
  }
`;

function errorText(error: unknown): string {
  if (error instanceof LoginError) {
    if (
      [
        'invalid_login_request',
        'invalid_browser_session',
        'invalid_login_flow',
        'login_expired',
      ].includes(error.message)
    )
      return 'This sign-in has expired. Open Monoid and try again.';
    if (error.message === 'reown_reauthentication_required')
      return 'Your sign-in has expired. Please sign in again.';
    if (error.message === 'rate_limited')
      return 'Please wait a minute and try again.';
  }
  return 'Unable to finish signing in. Please try again.';
}

let flow: string | null = null;
try {
  flow = restoreFlow(location, history, sessionStorage);
} catch {
  history.replaceState(null, '', location.pathname);
}
const browserFlow = flow ? new BrowserFlow(flow, sessionStorage) : null;

function LoginPage(): ReactNode {
  const login = useRef<ReownLogin | null>(null);
  const alive = useRef(true);
  const finishing = useRef(false);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [message, setMessage] = useState(
    browserFlow
      ? 'Preparing sign-in…'
      : 'Open sign-in from Monoid to continue.',
  );
  const [error, setError] = useState(false);
  const [returned, setReturned] = useState<{
    url: string;
    cancelled: boolean;
  } | null>(null);

  const showError = (error: unknown) => {
    setError(true);
    setMessage(errorText(error));
  };

  useEffect(() => {
    if (!browserFlow) return;
    void browserFlow
      .context()
      .then(async context => {
        if (!alive.current) return;
        if (
          !context.projectId ||
          !Number.isFinite(context.expiresAt) ||
          context.expiresAt <= Date.now()
        )
          throw new LoginError('login_expired');
        const {createLogin} = await import('./reown.js');
        if (!alive.current) return;
        login.current = createLogin(
          context.projectId,
          value => {
            if (!alive.current || finishing.current) return;
            setIdentity(value);
            setError(false);
            setMessage(
              value
                ? 'Continue with this account.'
                : 'Choose an account to sign in.',
            );
          },
          () => {
            if (alive.current && !finishing.current) showError(new Error());
          },
        );
        setReady(true);
        setMessage('Choose an account to sign in.');
        expiryTimer.current = setTimeout(() => {
          if (finishing.current) return;
          login.current?.stop();
          setReady(false);
          setIdentity(null);
          showError(new LoginError('login_expired'));
        }, context.expiresAt - Date.now());
      })
      .catch(error => {
        if (alive.current) showError(error);
      });
    return () => {
      alive.current = false;
      clearTimeout(expiryTimer.current);
      login.current?.stop();
    };
  }, []);

  const finish = async (cancelled: boolean) => {
    if (finishing.current || !browserFlow) return;
    finishing.current = true;
    setBusy(true);
    setError(false);
    setMessage(cancelled ? 'Returning to Monoid…' : 'Signing in…');
    try {
      const credential = cancelled ? null : await login.current?.credential();
      if (!cancelled && !credential) {
        setIdentity(null);
        setMessage('Please confirm your account and sign in again.');
        return;
      }
      const url = await browserFlow.finish(
        cancelled ? 'cancel' : 'complete',
        credential,
      );
      if (!url) return;
      clearTimeout(expiryTimer.current);
      // Erase local credentials now; async SDK sign-out must not delay return.
      void login.current?.signOut();
      setReady(false);
      setReturned({url, cancelled});
      location.assign(url);
    } catch (error) {
      showError(error);
    } finally {
      finishing.current = false;
      setBusy(false);
    }
  };

  const openLogin = async (changeAccount = false) => {
    if (!login.current) return;
    setBusy(true);
    setError(false);
    try {
      if (changeAccount) await login.current.changeAccount();
      else await login.current.open();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      {!(returned && !returned.cancelled) && (
        <IdentityBlock>
          <Logo src={monoidLogo} alt="Monoid" />
          <Title>Sign in to Monoid</Title>
          <AuthorityTag>
            <LockTag>
              <AppIcon icon={Lock} aria-hidden="true" />
            </LockTag>
            <IconTagName>{location.host}</IconTagName>
          </AuthorityTag>
          <Secondary>
            Monoid uses this account to issue Authority bundles for your cards.
          </Secondary>
        </IdentityBlock>
      )}
      <Content>
        {returned ? (
          returned.cancelled ? (
            <InfoMessage>Sign-in cancelled.</InfoMessage>
          ) : (
            <Completed>
              <OperationComplete label="Signed in" />
              <Secondary>Return to Monoid to continue.</Secondary>
            </Completed>
          )
        ) : error ? (
          <WarningMessage role="alert">{message}</WarningMessage>
        ) : identity ? (
          <AccountCard
            account={identity}
            busy={busy}
            onChange={() => void openLogin(true)}
          />
        ) : browserFlow && !ready ? (
          <Preparing role="status" aria-label="Preparing sign-in">
            <StandaloneLoadingSpinner />
          </Preparing>
        ) : !browserFlow ||
          busy ||
          message !== 'Choose an account to sign in.' ? (
          <InfoMessage aria-live="polite">{message}</InfoMessage>
        ) : null}
      </Content>
      <Actions>
        {returned ? (
          <Button color="neutral" onClick={() => location.assign(returned.url)}>
            Back to Monoid
          </Button>
        ) : ready ? (
          <>
            {identity ? (
              <Button loading={busy} onClick={() => void finish(false)}>
                Continue
              </Button>
            ) : (
              <Button loading={busy} onClick={() => void openLogin()}>
                Sign in
              </Button>
            )}
            <Button
              color="neutral"
              disabled={busy}
              onClick={() => void finish(true)}
            >
              Cancel
            </Button>
          </>
        ) : null}
      </Actions>
    </Page>
  );
}

createRoot(document.getElementById('root')!).render(<LoginPage />);
