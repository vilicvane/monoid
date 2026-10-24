import {setupIonicReact} from '@ionic/react';
import {createRoot} from 'react-dom/client';
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {styled} from 'styled-components';
import '@ionic/react/css/core.css';
import '@ionic/react/css/normalize.css';
import '@ionic/react/css/structure.css';
import '@ionic/react/css/typography.css';
import '../../../../src/@styles/variables.css';
import {Button, Buttons} from './button.js';
import {
  InfoFieldset,
  InfoLegend,
  InfoSection,
  InfoSectionItemContent,
} from '../../../../src/@components/@ui/info-section.js';
import {
  ViewHeader,
  ViewHeaderTitle,
} from '../../../../src/@components/@view/view-header.js';
import {ViewContext} from '../../../../src/@components/@view/@view-context.js';
import {BrowserFlow, LoginError, restoreFlow} from './flow.mjs';
import type {Identity, ReownLogin} from './reown.js';
import './style.css';

setupIonicReact();

const Page = styled.main`
  --view-padding: 16px;
  --view-padding-top: calc(var(--view-inset-top) + var(--view-padding));
  width: 100%;
  max-width: 480px;
  min-height: 100dvh;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  background: var(--ion-color-primary-contrast);
`;

const Content = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px var(--view-padding) 24px;
`;

const Description = styled.p`
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 14px;
  line-height: 1.5;
`;

const Status = styled(Description)<{$error?: boolean}>`
  color: ${props =>
    props.$error ? 'var(--color-text-danger)' : 'var(--color-text-secondary)'};
`;

const Actions = styled(Buttons)`
  flex: 0 0 auto;
  padding: 0 16px calc(16px + var(--view-inset-bottom));
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
      const token = cancelled ? null : await login.current?.credential();
      if (!cancelled && !token) {
        setIdentity(null);
        setMessage('Please confirm your account and sign in again.');
        return;
      }
      const url = await browserFlow.finish(
        cancelled ? 'cancel' : 'complete',
        token,
      );
      if (!url) return;
      clearTimeout(expiryTimer.current);
      login.current?.stop();
      setReady(false);
      setReturned({url, cancelled});
      setMessage(
        cancelled
          ? 'Sign-in cancelled.'
          : 'Return to Monoid to finish signing in.',
      );
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
    <ViewContext.Provider value={{scrolled: false}}>
      <Page>
        <ViewHeader>
          <ViewHeaderTitle>Monoid</ViewHeaderTitle>
        </ViewHeader>
        <Content>
          <InfoSection>
            <h2 className="login-heading">
              {returned
                ? returned.cancelled
                  ? 'Sign-in cancelled'
                  : 'Sign-in approved'
                : 'Sign in'}
            </h2>
            <Status
              role={error ? 'alert' : 'status'}
              aria-live="polite"
              $error={error}
            >
              {message}
            </Status>
          </InfoSection>
          {identity && !returned && (
            <InfoFieldset>
              <InfoLegend>Account</InfoLegend>
              <InfoSectionItemContent>
                {identity.email || 'Connected account'}
              </InfoSectionItemContent>
            </InfoFieldset>
          )}
        </Content>
        <Actions>
          {returned ? (
            <Button onClick={() => location.assign(returned.url)}>
              Return to Monoid
            </Button>
          ) : ready ? (
            <>
              {identity ? (
                <>
                  <Button loading={busy} onClick={() => void finish(false)}>
                    Continue
                  </Button>
                  <Button
                    color="neutral"
                    disabled={busy}
                    onClick={() => void openLogin(true)}
                  >
                    Use another account
                  </Button>
                </>
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
    </ViewContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<LoginPage />);
