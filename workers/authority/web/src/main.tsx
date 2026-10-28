import {setupIonicReact} from '@ionic/react';
import {createRoot} from 'react-dom/client';
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {styled} from 'styled-components';
import {Certificate} from 'lucide-react';
import {Button, Buttons} from './button.js';
import monoidLogo from '../../../../src/@assets/monoid.svg';
import googleLogo from './assets/google-g.svg';
import githubLogo from './assets/github-invertocat.svg?raw';
import {AppIcon} from '../../../../src/@components/@ui/app-icon.js';
import {Tag, leadingIconTagCSS} from '../../../../src/@components/@ui/tag.js';
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
import type {Account} from '../../src/domain.js';
import type {WalletLogin} from './wallet.js';
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

const AuthorityTag = styled(Tag).attrs({as: 'span'})`
  ${leadingIconTagCSS}

  background-color: var(
    --color-address-tag-background,
    var(--ion-color-dark-contrast)
  );
  border-color: var(--color-address-tag-border, var(--ion-color-light-shade));
  color: var(--color-address-tag-text, var(--ion-color-dark));

  align-self: center;
  min-width: 0;
  max-width: 100%;
`;

const CertificateIcon = styled(AppIcon)`
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  display: block;
`;

const AuthorityHost = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
    if (error.message === 'unauthorized')
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
  const wallet = useRef<WalletLogin | null>(null);
  const alive = useRef(true);
  const finishing = useRef(false);
  const projectId = useRef('');
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [providers, setProviders] = useState({
    google: false,
    github: false,
    wallet: false,
  });
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
      .then(context => {
        if (!alive.current) return;
        if (
          !Number.isFinite(context.expiresAt) ||
          context.expiresAt <= Date.now()
        )
          throw new LoginError('login_expired');
        projectId.current = context.projectId;
        setProviders(context.providers);
        setAccount(context.account);
        setReady(true);
        setMessage('Choose an account to sign in.');
        if (context.error) showError(new LoginError(context.error));
        expiryTimer.current = setTimeout(() => {
          if (finishing.current) return;
          wallet.current?.stop();
          setReady(false);
          setAccount(null);
          showError(new LoginError('login_expired'));
        }, context.expiresAt - Date.now());
      })
      .catch(error => {
        if (alive.current) showError(error);
      });
    return () => {
      alive.current = false;
      clearTimeout(expiryTimer.current);
      wallet.current?.stop();
    };
  }, []);

  const finish = async (cancelled: boolean) => {
    if (finishing.current || !browserFlow) return;
    finishing.current = true;
    setBusy(true);
    setError(false);
    setMessage(cancelled ? 'Returning to Monoid…' : 'Signing in…');
    try {
      const url = await browserFlow.finish(cancelled ? 'cancel' : 'complete');
      if (!url) return;
      clearTimeout(expiryTimer.current);
      void wallet.current?.signOut().catch(() => {});
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

  const choose = async (provider: 'google' | 'github' | 'wallet') => {
    if (!browserFlow) return;
    setBusy(true);
    setError(false);
    try {
      if (provider === 'wallet') {
        if (!wallet.current) {
          const {createWalletLogin} = await import('./wallet.js');
          wallet.current = createWalletLogin(
            projectId.current,
            browserFlow,
            value => {
              if (!alive.current || finishing.current) return;
              setAccount(value);
              setError(false);
              setMessage('Choose an account to sign in.');
            },
            () => {
              if (alive.current && !finishing.current) showError(new Error());
            },
          );
        }
        await wallet.current.open();
      } else {
        await wallet.current?.changeAccount();
        const result = await browserFlow.request(provider, {
          flow: browserFlow.flow,
        });
        location.assign(result.authorizationUrl);
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const changeAccount = async () => {
    if (!browserFlow) return;
    setBusy(true);
    setError(false);
    try {
      await wallet.current?.changeAccount();
      await browserFlow.request('reset', {flow: browserFlow.flow});
      setAccount(null);
      setMessage('Choose an account to sign in.');
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
            <CertificateIcon icon={Certificate} aria-hidden="true" />
            <AuthorityHost>{location.host}</AuthorityHost>
          </AuthorityTag>
          <Secondary>
            Monoid uses this account to issue authority bundles for your cards.
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
        ) : account ? (
          <AccountCard
            account={account}
            busy={busy}
            onChange={() => void changeAccount()}
          />
        ) : browserFlow && !ready ? (
          <Preparing role="status" aria-label="Preparing sign-in">
            <StandaloneLoadingSpinner />
          </Preparing>
        ) : !browserFlow || message !== 'Choose an account to sign in.' ? (
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
            {account ? (
              <Button loading={busy} onClick={() => void finish(false)}>
                Continue
              </Button>
            ) : (
              <>
                <Button
                  color="neutral"
                  icon={<img src={googleLogo} alt="" />}
                  disabled={busy || !providers.google}
                  onClick={() => void choose('google')}
                >
                  Continue with Google
                </Button>
                <Button
                  color="neutral"
                  icon={
                    <AppIcon
                      icon={githubLogo}
                      aria-hidden="true"
                      focusable="false"
                    />
                  }
                  disabled={busy || !providers.github}
                  onClick={() => void choose('github')}
                >
                  Continue with GitHub
                </Button>
                <Button
                  color="neutral"
                  disabled={busy || !providers.wallet}
                  onClick={() => void choose('wallet')}
                >
                  Connect wallet
                </Button>
              </>
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
      <nav className="legal-links" aria-label="Policies">
        <a href={`${import.meta.env.BASE_URL}privacy`}>Privacy</a>
        <span aria-hidden="true"> · </span>
        <a href={`${import.meta.env.BASE_URL}terms`}>Terms</a>
      </nav>
    </Page>
  );
}

createRoot(document.getElementById('root')!).render(<LoginPage />);
